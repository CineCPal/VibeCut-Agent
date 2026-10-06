/**
 * Direct edits on the timeline open in Premiere or Resolve (PLAN.md, Phase 4b), ported from VibeCut's
 * timelineEdits.ts. They change the user's own timeline, so the first edit of each request copies it
 * first ("Interview (before VibeCut 1)", made by the editor's `backup_timeline`), and every edit is
 * logged in `useEditLogStore` with what it replaced, for `revertTimelineEdits`.
 */
import { nleCall } from "../ipc";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import type { EditEntry, EditResult, RevertResult, TimelineChange } from "../../types/edits";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { clock, type ToolOutcome } from "./args";

export const HOST_SHORT: Record<NleHost, string> = { premiere: "Premiere", resolve: "Resolve" };
export const TIMELINE_NOUN: Record<NleHost, string> = { premiere: "sequence", resolve: "timeline" };

/** Where an edit acts, and the request it's for. */
export interface EditContext {
  host: NleHost;
  timeline: string;
  step: string;
  stepText: string;
}

export const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const trackLabel = (type: string, index: number) => `${type === "video" ? "V" : "A"}${index}`;

/** The backup for this request: made before its first direct edit, then reused. */
async function ensureBackup(ctx: EditContext): Promise<string> {
  const key = `${ctx.step}|${ctx.host}|${ctx.timeline}`;
  const known = useEditLogStore.getState().backups[key];
  if (known) return known;
  const { backup } = await nleCall<{ backup: string }>(ctx.host, "backup_timeline", { timeline: ctx.timeline });
  useEditLogStore.getState().setBackup(key, backup);
  return backup;
}

/** The clip ids an edit names, wherever its arguments carry them. */
function namedIds(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  add(args.itemId);
  if (Array.isArray(args.itemIds)) args.itemIds.forEach(add);
  if (Array.isArray(args.levels)) for (const entry of args.levels as Record<string, unknown>[]) add(entry?.itemId);
  return out;
}

/** Refuses an edit of a clip, or of a clip linked to it, on a locked track (VibeCut's 8a.0 probe:
 * Premiere's scripting edits a locked track anyway; Resolve refuses without saying why). */
function refuseLocked(ctx: EditContext, timeline: HostTimeline, args: Record<string, unknown>): void {
  const where = new Map<string, { type: string; index: number; locked: boolean }>();
  const linked = new Map<string, string[]>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      where.set(clip.id, { type: track.type, index: track.index, locked: track.locked === true });
      linked.set(clip.id, clip.linkedIds ?? []);
    }
  }
  for (const id of namedIds(args)) {
    for (const each of [id, ...(linked.get(id) ?? [])]) {
      const at = where.get(each);
      if (at?.locked) throw new Error(`${trackLabel(at.type, at.index)} is locked in ${HOST_SHORT[ctx.host]}; unlock it first, or ask the user`);
    }
  }
}

/** Reads the open timeline (for an executor that needs its clips). */
export function readTimeline(ctx: EditContext): Promise<HostTimeline> {
  return nleCall<HostTimeline>(ctx.host, "read_timeline", { timeline: ctx.timeline });
}

/** Backs up (once per request), runs the edit, logs it and reports. */
export async function edit(
  ctx: EditContext,
  tool: string,
  command: string,
  args: Record<string, unknown>,
  describe: (result: EditResult) => string,
): Promise<ToolOutcome> {
  if (namedIds(args).length) refuseLocked(ctx, await readTimeline(ctx), args);
  const backup = await ensureBackup(ctx);
  const result = await nleCall<EditResult>(ctx.host, command, { timeline: ctx.timeline, ...args });
  if (result.renamed) useEditLogStore.getState().addRestoredIds(ctx.host, result.renamed);
  const parts = [result.changes.length ? describe(result) : "Nothing needed changing"];
  if (result.refused.length) parts.push(`${HOST_SHORT[ctx.host]} refused ${result.refused.length}: ${result.refused.map((r) => r.reason).join("; ")}`);
  const summary = parts.join("; ");
  let editId: string | undefined;
  if (result.changes.length) {
    editId = useEditLogStore.getState().log({
      step: ctx.step,
      stepText: ctx.stepText,
      host: ctx.host,
      timeline: ctx.timeline,
      tool,
      summary,
      backup,
      changes: result.changes,
    }).id;
  }
  return {
    summary: `${summary} (backup: "${backup}")`,
    result: {
      ...(editId ? { editId } : {}),
      changes: result.changes,
      backup,
      ...(result.refused.length ? { refused: result.refused } : {}),
    },
  };
}

/** The changes with every id a revert or replacement has changed since followed to the clip's current one. */
export function followed(changes: TimelineChange[], restored: Record<string, string>): TimelineChange[] {
  const follow = (id: string) => {
    let current = id;
    for (let hops = 0; restored[current] && hops < 50; hops++) current = restored[current];
    return current;
  };
  return changes.map((c) => ({
    ...c,
    ...(c.itemId ? { itemId: follow(c.itemId) } : {}),
    ...(c.incomingId ? { incomingId: follow(c.incomingId) } : {}),
    ...(c.itemIds ? { itemIds: c.itemIds.map(follow) } : {}),
    ...(c.deletedWith ? { deletedWith: c.deletedWith.map(follow) } : {}),
    // A link change names its groups' clips; a later reshape (Resolve) replaces them.
    ...(c.groupsBefore ? { groupsBefore: c.groupsBefore.map((g) => g.map(follow)) } : {}),
    ...(c.groupsAfter ? { groupsAfter: c.groupsAfter.map((g) => g.map(follow)) } : {}),
    // A reshape or split names where its clips ended up; later reshapes and reverts replaced them since.
    ...(c.items
      ? {
          items: c.items.map((i) => ({
            ...i,
            ...(i.after ? { after: { ...i.after, id: follow(i.after.id) } } : {}),
            ...(i.right ? { right: { ...i.right, id: follow(i.right.id) } } : {}),
          })),
        }
      : {}),
  }));
}

/** Reverts logged edits, newest first, one entry at a time. Entries already reverted are skipped. */
export async function revertTimelineEdits(entryIds: string[]): Promise<ToolOutcome> {
  const entries = useEditLogStore
    .getState()
    .entries.filter((e) => entryIds.includes(e.id) && !e.reverted)
    .reverse();
  if (entries.length === 0) throw new Error("Those timeline edits are already reverted, or there are none");
  const totals = { reverted: 0, changedSince: [] as RevertResult["changedSince"], failed: [] as RevertResult["failed"], lost: [] as string[], graded: [] as string[] };
  for (const entry of entries) {
    const result = await nleCall<RevertResult>(entry.host, "revert_timeline_changes", {
      timeline: entry.timeline,
      changes: followed(entry.changes, useEditLogStore.getState().restoredIds[entry.host]),
      ...(entry.backup ? { backup: entry.backup } : {}),
    });
    useEditLogStore.getState().addRestoredIds(entry.host, result.restoredIds);
    useEditLogStore.getState().markReverted(entry.id, {
      at: Date.now(),
      changedSince: result.changedSince.length,
      failed: result.failed.length,
      lost: result.lost,
    });
    totals.reverted += result.reverted.length;
    totals.changedSince.push(...result.changedSince);
    totals.failed.push(...result.failed);
    totals.lost.push(...result.lost);
    totals.graded.push(...(result.gradedFromBackup ?? []));
  }
  const host = entries[0].host;
  const backups = [...new Set(entries.map((e) => e.backup).filter(Boolean))];
  const parts = [`Reverted ${count(totals.reverted, "timeline change")}`];
  if (totals.changedSince.length) parts.push(`left ${totals.changedSince.length} that changed since (${totals.changedSince.map((c) => `${c.name}: ${c.reason}`).join("; ")})`);
  if (totals.failed.length) parts.push(`${totals.failed.length} couldn't be undone (${totals.failed.map((c) => `${c.name}: ${c.reason}`).join("; ")})`);
  const graded = new Set(totals.graded);
  const lost = [...new Set(totals.lost)];
  const withGrade = lost.filter((n) => graded.has(n));
  const without = lost.filter((n) => !graded.has(n));
  if (without.length && host === "premiere") {
    parts.push(`${without.join(", ")} put back from the file without its effects; "${backups.join('", "')}" still has them`);
  } else {
    if (withGrade.length) parts.push(`${withGrade.join(", ")} put back with the grade, transform and fades from "${backups.join('", "')}" (Fusion effects and keyframes aren't restored)`);
    if (without.length) parts.push(`${without.join(", ")} put back from the source without its grade or effects; "${backups.join('", "')}" still has them`);
  }
  return { summary: parts.join("; "), result: { ...totals, lost, backups } };
}

/** Reverts every edit of the latest request that has unreverted ones (the chat's Revert button). */
export async function revertLastRequest(): Promise<ToolOutcome> {
  return revertTimelineEdits(lastEditStep());
}

/** One change as the chat lists it (VibeCut's describeTimelineChange, for the kinds made here). */
export function describeTimelineChange(change: TimelineChange, fps = 25): string {
  const name = change.name ? `"${change.name}"` : "a clip";
  switch (change.kind) {
    case "added":
      return `${name} added at ${clock(change.at ?? 0)}–${clock(change.end ?? 0)} on ${(change.tracks ?? []).join("+")}`;
    case "deleted":
      return `${name} removed from ${change.track ? trackLabel(change.track[0], change.track[1]) : "its track"} at ${clock(change.start ?? 0)}`;
    case "enabled":
      return `${name} switched ${change.after ? "on" : "off"}`;
    case "level":
      return `${name} level ${String(change.before ?? 0)} → ${String(change.after)} dB`;
    case "reshaped": {
      const first = change.items?.[0];
      if (!first) return `${name} ${change.how ?? "reshaped"}`;
      const notCarried = change.notCarried?.length ? ` (not carried: ${change.notCarried.join(", ")})` : "";
      if (change.how === "slipped" && first.before.sourceStartFrame !== undefined && first.after.sourceStartFrame !== undefined) {
        return `${name} slipped: source from ${clock(first.before.sourceStartFrame / fps)} → ${clock(first.after.sourceStartFrame / fps)}${notCarried}`;
      }
      const where = (p: { track: [string, number]; start: number; end: number }) => `${clock(p.start)}–${clock(p.end)} on ${trackLabel(p.track[0], p.track[1])}`;
      return `${name} ${change.how ?? "reshaped"}: ${where(first.before)} → ${where(first.after)}${notCarried}`;
    }
    case "fade":
      return `${name} ${change.which === "fadeOut" ? "fade out" : "fade in"} ${clock(Number(change.before ?? 0))} → ${clock(Number(change.after ?? 0))}${change.clamped ? " (cut to fit)" : ""}`;
    case "transition": {
      const on = `on the cut at ${clock(change.cut ?? 0)}${change.track ? ` (${trackLabel(change.track[0], change.track[1])})` : ""}`;
      const state = (t: unknown) => (t && typeof t === "object" ? `${(t as { type: string }).type} ${clock((t as { seconds: number }).seconds)}` : "none");
      const verb = !change.after ? "removed" : change.before ? `${state(change.before)} → ${state(change.after)}` : state(change.after);
      return `${verb} ${on}, ${name}${change.clamped ? " (cut to fit the media)" : ""}`;
    }
    case "duck":
      return `${name} ducked ${change.duckDb ?? -12} dB in ${change.spans ?? 1} place${change.spans === 1 ? "" : "s"} (Level keyframes)`;
    case "link":
      return `${name} ${change.action === "unlinked" ? "unlinked" : "linked"} with ${Math.max(0, ((change.itemIds as string[] | undefined)?.length ?? 1) - 1)} other clip(s)`;
    case "split": {
      const tracks = (change.items ?? []).map((i) => trackLabel(i.before.track[0], i.before.track[1]));
      return `${name} split at ${clock(change.cut ?? 0)} on ${tracks.join("+")}${change.notCarried?.length ? ` (not carried: ${change.notCarried.join(", ")})` : ""}`;
    }
  }
}

/** The line put ahead of each message about the edits made so far, so the agent can revert by id. */
export function editLogContext(entries: EditEntry[] = useEditLogStore.getState().entries): string | null {
  if (entries.length === 0) return null;
  const live = entries.filter((e) => !e.reverted);
  const recent = live.slice(-5).map((e) => `${e.id} ${e.summary}`);
  return `Your direct timeline edits this session: ${entries.length} (${live.length} not reverted)${recent.length ? `; latest: ${recent.join(" | ")}` : ""}`;
}
