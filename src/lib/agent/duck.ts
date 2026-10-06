/**
 * Turning music down under dialogue (ported from VibeCut's hostAudio.ts `duck_music`).
 *
 * VibeCut found the speech from its transcripts. This app has none, so the dips go where dialogue sits
 * on the timeline: under the sound clips given as `dialogueClipIds` (default: every sound clip that
 * isn't the music), or under explicit `spans`. Premiere keyframes the music's Level (`duck_clip`, which
 * keeps its fades). Resolve's scripting has no audio keyframes, so the music is split at each dip, the
 * pieces under dialogue turned down and each cut crossfaded. Every step is a logged edit, so Revert
 * takes the duck off again.
 */
import { clock, num, optNum, strArray, type Args, type ToolOutcome } from "./args";
import { describeTimelineChange, edit, readTimeline, type EditContext } from "./edits";
import type { EditResult } from "../../types/edits";
import type { HostClip, HostTimeline } from "../../types/timeline";

export interface Span {
  start: number;
  end: number;
}

/** Dialogue as duck spans: each widened by `lead` before and `tail` after, and spans closer than `bridge`
 * joined, so the music doesn't pump up between sentences. */
export function speechSpans(lines: Span[], lead: number, tail: number, bridge: number): Span[] {
  const spans: Span[] = [];
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, line.start - lead);
    const end = line.end + tail;
    const last = spans[spans.length - 1];
    if (last && start - last.end <= bridge) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  return spans;
}

/** The dips inside a clip from `start` to `end`: spans kept a ramp clear of its edges, joined when the gap
 * between them is under two ramps, and dropped when under `minimum` long. Mirrors `duck_keys` in
 * premiere_effects.py. */
export function dipsWithin(spans: Span[], start: number, end: number, ramp: number, minimum: number): Span[] {
  const dips: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const a = Math.max(start + ramp, span.start);
    const b = Math.min(end - ramp, span.end);
    if (b - a < minimum) continue;
    const last = dips[dips.length - 1];
    if (last && a - last.end <= 2 * ramp) last.end = Math.max(last.end, b);
    else dips.push({ start: a, end: b });
  }
  return dips;
}

const MAX_RESOLVE_CUTS = 80;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Located {
  clip: HostClip;
  type: string;
  index: number;
}

function located(view: HostTimeline, id: string): Located | null {
  for (const track of view.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { clip, type: track.type, index: track.index };
  }
  return null;
}

function clipAcross(view: HostTimeline, type: string, index: number, time: number): HostClip | null {
  const track = view.tracks.find((t) => t.type === type && t.index === index);
  return track?.clips.find((c) => c.kind !== "effect" && c.start < time - 1e-3 && c.end > time + 1e-3) ?? null;
}

/** The given spans, else the dialogue clips' places: the given ones, else every other sound clip. */
function dialogueLines(view: HostTimeline, args: Args, musicIds: Set<string>): Span[] {
  if (Array.isArray(args.spans)) {
    return (args.spans as Args[]).map((s, i) => {
      if (typeof s !== "object" || s === null) throw new Error(`spans[${i}] must be {start, end}`);
      const span = { start: num(s, "start"), end: num(s, "end") };
      if (span.end <= span.start) throw new Error(`spans[${i}] must end after it starts`);
      return span;
    });
  }
  const given = args.dialogueClipIds === undefined ? null : new Set(strArray(args, "dialogueClipIds"));
  const lines: Span[] = [];
  for (const track of view.tracks) {
    if (track.type !== "audio") continue;
    for (const clip of track.clips) {
      if (clip.kind === "effect" || !clip.enabled || musicIds.has(clip.id)) continue;
      if (given ? given.has(clip.id) : true) lines.push({ start: clip.start, end: clip.end });
    }
  }
  return lines;
}

/** Resolve: split, turn down and crossfade one music clip over `dips`, reading the timeline after each split. */
async function duckOnResolve(ctx: EditContext, music: Located, dips: Span[], duckDb: number, ramp: number, fps: number): Promise<string[]> {
  const forDuck = (r: EditResult) => `For the duck: ${r.changes.map((c) => describeTimelineChange(c, fps)).join("; ")}`;
  const snap = (t: number) => Math.round(t * fps) / fps;
  const cuts = [...new Set(dips.flatMap((d) => [snap(d.start), snap(d.end)]))].sort((a, b) => b - a);
  if (cuts.length > MAX_RESOLVE_CUTS) throw new Error(`That would cut "${music.clip.name}" in ${cuts.length} places; duck a shorter stretch, or raise bridgeSeconds`);
  const lines: string[] = [];
  // From the last cut back, so the piece to cut is always the one starting where the clip did.
  for (const time of cuts) {
    const piece = clipAcross(await readTimeline(ctx), music.type, music.index, time);
    if (!piece) continue;
    await edit(ctx, "duck_music", "split_clips", { itemIds: [piece.id], time }, forDuck);
  }
  lines.push(`Cut "${music.clip.name}" at ${cuts.length} point${cuts.length === 1 ? "" : "s"}`);
  const view = await readTimeline(ctx);
  const track = view.tracks.find((t) => t.type === music.type && t.index === music.index);
  const pieces = (track?.clips ?? []).filter((c) => c.kind !== "effect" && c.start >= music.clip.start - 1e-3 && c.end <= music.clip.end + 1e-3);
  const under = pieces.filter((c) => dips.some((d) => (c.start + c.end) / 2 > d.start && (c.start + c.end) / 2 < d.end));
  if (under.length) {
    const levels = under.map((c) => ({ itemId: c.id, volumeDb: round2((c.volumeDb ?? 0) + duckDb) }));
    await edit(ctx, "duck_music", "set_clip_levels", { levels }, forDuck);
    lines.push(`turned ${under.length} piece${under.length === 1 ? "" : "s"} down ${Math.abs(duckDb)} dB`);
  }
  let faded = 0;
  const refused: string[] = [];
  for (const time of [...cuts].reverse()) {
    const outgoing = clipAcross(await readTimeline(ctx), music.type, music.index, time - 0.5 / fps);
    if (!outgoing || Math.abs(outgoing.end - time) > 1 / fps) continue;
    try {
      await edit(ctx, "duck_music", "set_transition", { itemId: outgoing.id, kind: "dissolve", seconds: ramp }, forDuck);
      faded++;
    } catch (error) {
      refused.push(`${clock(time)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  lines.push(`crossfaded ${faded} cut${faded === 1 ? "" : "s"} over ${clock(ramp)}`);
  if (refused.length) lines.push(`no crossfade at ${refused.join("; ")}`);
  return lines;
}

export async function duckMusic(ctx: EditContext, args: Args): Promise<ToolOutcome> {
  const ids = strArray(args, "musicClipIds");
  const duckDb = optNum(args, "duckDb") ?? -12;
  if (duckDb < -40 || duckDb > -1) throw new Error("duckDb must be from -40 to -1 (how far the music goes down)");
  const ramp = optNum(args, "rampSeconds") ?? 0.3;
  if (ramp < 0.05 || ramp > 2) throw new Error("rampSeconds must be from 0.05 to 2");
  const lead = optNum(args, "leadSeconds") ?? 0.2;
  const tail = optNum(args, "tailSeconds") ?? 0.4;
  const bridge = optNum(args, "bridgeSeconds") ?? 1.0;
  if ([lead, tail, bridge].some((n) => n < 0 || n > 5)) throw new Error("leadSeconds, tailSeconds and bridgeSeconds must be from 0 to 5");

  const view = await readTimeline(ctx);
  const musics = ids.map((id) => {
    const found = located(view, id);
    if (!found || found.clip.kind === "effect" || found.type !== "audio") throw new Error(`${id} isn't a sound clip on the open ${ctx.host === "premiere" ? "sequence" : "timeline"}`);
    return found;
  });
  const lines = dialogueLines(view, args, new Set(ids));
  if (!lines.length) throw new Error("There's no dialogue to duck under: give dialogueClipIds or spans");
  const spans = speechSpans(lines, lead, tail, bridge);
  const summaries: string[] = [];
  const results: unknown[] = [];
  for (const music of musics) {
    if (ctx.host === "premiere") {
      const outcome = await edit(ctx, "duck_music", "duck_clip", { itemId: music.clip.id, spans, duckDb, rampSeconds: ramp }, (r) =>
        r.changes.map((c) => `"${c.name}" ducked ${Math.abs(duckDb)} dB under dialogue in ${c.spans} place${c.spans === 1 ? "" : "s"}`).join("; "),
      );
      summaries.push(outcome.summary);
      results.push(outcome.result);
    } else {
      const dips = dipsWithin(spans, music.clip.start, music.clip.end, ramp, 1 / view.fps);
      if (!dips.length) {
        summaries.push(`No dialogue runs under "${music.clip.name}"; left as it is`);
        continue;
      }
      summaries.push((await duckOnResolve(ctx, music, dips, duckDb, ramp, view.fps)).join(", "));
    }
  }
  return { summary: summaries.join(". "), result: { ducked: summaries, spans, ...(results.length ? { edits: results } : {}) } };
}
