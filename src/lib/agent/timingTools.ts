/**
 * Speed, transitions, tracks and track switches on the connected timeline (PLAN.md, "Phase 12b–12d"),
 * ported from VibeCut's timelineEdits.ts (set_transition, set_clip_speed, add_track, remove_track) and
 * hostStructure.ts (set_track_options). They're direct edits through `edit()`: a backup first, the edit
 * log, and Revert. The editors' watchers do the work (premiere_timing / premiere_effects /
 * premiere_structure, resolve_timing / resolve_effects / resolve_structure).
 *
 * A speed change with a draft open changes the draft; Premiere can't ripple a speed change from a
 * script, so a ripple there is made in a draft too (opened if needed), as VibeCut does.
 *
 * Phase 16c: set_speed_ramp and clear_clip_speed, from VibeCut's hostSpeed.ts. Neither editor can script
 * a ramp on a clip already on a timeline, so a ramp goes into the draft (opened if needed), and send_to_*
 * builds it as consecutive pieces at constant speeds (interchange/time_remap.speed_pieces).
 */
import type { NleHost } from "../../types/nle";
import { setDraftSpeed, setDraftSpeedRamp, type HostDraft } from "../../vibecut/lib/connect/hostDraft";
import { bool, num, optNum, optStr, type Args, type Executor } from "./args";
import { draftOf, openDraft, refuseWhileDrafting, saveDraft } from "./draft";
import { describeTimelineChange, edit, HOST_SHORT, TIMELINE_NOUN, type EditContext } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

const SPEED_RANGE = "speed must be from 0.05 to 20 (1 is normal; 2 is twice as fast)";
const OPTIONS = ["enabled", "muted", "locked", "soloed", "syncLocked", "targeted"] as const;
const upper = (line: string) => line.charAt(0).toUpperCase() + line.slice(1);

/** The draft's id for a clip: a draft clip's own ("draft-3"), else the one cut from that timeline clip. */
export function draftIdFor(draft: HostDraft, clipId: string): string {
  if (clipId.startsWith("draft-")) return clipId;
  let n = 0;
  for (const kind of ["video", "audio"] as const) {
    for (const track of draft[kind]) {
      for (const clip of track.clips) {
        if (clip.originId === clipId) return `draft-${n}`;
        n++;
      }
    }
  }
  throw new Error(`There is no clip ${clipId} in the draft; the snapshot lists the draft's clips`);
}

/** set_speed_ramp's changes: "from this source time on, play at this speed" (VibeCut's changesArg). */
function changesArg(args: Args): { sourceTime: number; speed: number }[] {
  const raw = args.changes;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("changes must be a non-empty list of {sourceTime, speed}");
  if (raw.length > 50) throw new Error("At most 50 speed changes on one clip");
  return raw.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`changes[${i}] must be an object`);
    const item = c as Args;
    // Without a sourceTime, it's the starting speed (0 is at or before any clip's in point).
    return { sourceTime: optNum(item, "sourceTime") ?? 0, speed: num(item, "speed") };
  });
}

function trackType(args: Args): "video" | "audio" {
  const type = optStr(args, "type");
  if (type !== "video" && type !== "audio") throw new Error('type must be "video" or "audio"');
  return type;
}

export function timingToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const DIRECT = `Changes the open ${noun} itself (a backup copy is made first for each request); it can be reverted.`;
  return [
    {
      name: "set_clip_speed",
      description: `Plays a clip (with its linked picture or sound) at a constant speed: 2 is twice as fast, 0.5 half speed (0.05 to 20). Without ripple it keeps its place and length and shows more or less of its source (a speed-up needs that much more media). ripple=true keeps its source range instead, so it gets longer or shorter and everything after it on every track moves with its end: ${host === "resolve" ? "Resolve does that on the timeline itself" : "Premiere can't do that from a script, so it's made in a draft (send it afterwards)"}.${host === "premiere" ? " A clip with fades is refused (its fade keys wouldn't follow)." : ""} No reverse; for a speed change partway through use set_speed_ramp. With a draft open it changes the draft. Otherwise: ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A timeline clip id (a draft clip's while a draft is open)." },
          speed: { type: "NUMBER" },
          ripple: { type: "BOOLEAN", description: "Optional; default false." },
        },
        required: ["clipId", "speed"],
      },
    },
    {
      name: "set_speed_ramp",
      description: `Changes a clip's speed partway through (a speed ramp / time remap), with its linked picture or sound. changes are "from this source time on, play at this speed" (0.05 to 20): sourceTime is seconds into the clip's SOURCE file, between its sourceIn and sourceOut (the snapshot's "from"); a change at or before sourceIn (or without sourceTime) sets the starting speed, otherwise it starts at normal speed. easeSeconds smooths each change over that much source instead of switching at once. The clip keeps its source range, so its length follows; ripple (default true) moves everything after it on every track. ${HOST_SHORT[host]} can't script a ramp on its ${noun}, so this works in the DRAFT (opened if needed), and send_to_${host} builds the ramp as consecutive pieces at constant speeds (an ease becomes several short steps). Replaces any earlier speed change on the clip.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A timeline clip id (a draft clip's while a draft is open)." },
          changes: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { sourceTime: { type: "NUMBER", description: "Seconds into the clip's source file; leave it out for the starting speed." }, speed: { type: "NUMBER" } },
              required: ["speed"],
            },
          },
          easeSeconds: { type: "NUMBER", description: "Optional; default 0 (a sudden change)." },
          ripple: { type: "BOOLEAN", description: "Optional; default true." },
        },
        required: ["clipId", "changes"],
      },
    },
    {
      name: "clear_clip_speed",
      description: `Puts a clip back to normal speed, removing a constant speed change or a ramp. With a draft open it changes the draft (ripple, default true, moves what follows); otherwise it's set_clip_speed at 1 on the ${noun} itself.`,
      parameters: { type: "OBJECT", properties: { clipId: { type: "STRING", description: "A timeline clip id (a draft clip's while a draft is open)." }, ripple: { type: "BOOLEAN", description: "Optional; default true." } }, required: ["clipId"] },
    },
    {
      name: "set_transition",
      description: `Puts a transition on the cut at the END of clipId, into the clip that starts right there on the same track (there must be one), or removes it with kind "none". dissolve is a Cross Dissolve on picture and a crossfade on sound; dipToBlack dips through black (picture only). It sits centred on the cut; seconds defaults to 1 (or the current length when changing kind) and is cut to what fits: at most half of either clip, and for a dissolve only as much unused media as both files have past the cut. A dissolve with no such media is refused. Put it on the picture and, if wanted, separately on its sound. Not while a draft is open. ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "The clip BEFORE the cut." },
          kind: { type: "STRING", enum: ["dissolve", "dipToBlack", "none"], description: "none removes the transition." },
          seconds: { type: "NUMBER" },
        },
        required: ["clipId", "kind"],
      },
    },
    {
      name: "add_track",
      description: `Adds empty video or audio tracks at the end of the open ${noun} (above the top video track, below the last audio track). add_clips adds one by itself when it needs it, so this is for when the user asks. ${DIRECT}`,
      parameters: { type: "OBJECT", properties: { type: { type: "STRING", enum: ["video", "audio"] }, count: { type: "NUMBER", description: "1 to 4; default 1." } }, required: ["type"] },
    },
    {
      name: "remove_track",
      description: `Removes the last video or audio track of the open ${noun} when it's empty (a track with clips, one that isn't the last, or the only one, is refused). ${DIRECT}`,
      parameters: { type: "OBJECT", properties: { type: { type: "STRING", enum: ["video", "audio"] }, index: { type: "NUMBER", description: "1-based; must be the last. Optional." } }, required: ["type"] },
    },
    {
      name: "set_track_options",
      description: `Switches a track of the open ${noun}: ${
        host === "premiere"
          ? "enabled (Premiere's mute switch: a video track's output, an audio track's mute; muted is the same switch the other way round), locked (its clips can't be edited, by you or the user), targeted, and syncLocked"
          : `enabled (off leaves it out of playback and renders) and locked (its clips can't be edited, by you or the user); only on the timeline open in Resolve, and Resolve's scripting can't mute, target or sync-lock`
      }. Neither editor can solo a track from a script. ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["video", "audio"] },
          index: { type: "NUMBER", description: "1-based track number (V2 is video 2)." },
          enabled: { type: "BOOLEAN" },
          ...(host === "premiere" ? { muted: { type: "BOOLEAN" } } : {}),
          locked: { type: "BOOLEAN" },
          ...(host === "premiere" ? { targeted: { type: "BOOLEAN" }, syncLocked: { type: "BOOLEAN" } } : {}),
        },
        required: ["type", "index"],
      },
    },
  ];
}

/** Executors for the connected timeline as it is when each runs (`context.timeline` can change mid-turn). */
export function timingExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const editor = HOST_SHORT[host];
  const ctx = (): EditContext => {
    if (!context.timeline) throw new Error(`No ${TIMELINE_NOUN[host]} is open in ${editor}. Ask the user to open one, or create_timeline.`);
    return { host, timeline: context.timeline, step: context.step, stepText: context.stepText };
  };
  const direct = (what: string) => {
    refuseWhileDrafting(host, what);
    return ctx();
  };

  const executors: Record<string, Executor> = {
    set_clip_speed: async (args) => {
      const clipId = optStr(args, "clipId");
      if (!clipId) throw new Error("clipId must be a timeline clip id");
      const speed = num(args, "speed");
      if (!(speed >= 0.05 && speed <= 20)) throw new Error(SPEED_RANGE);
      const ripple = bool(args, "ripple");
      const draft = draftOf(host);
      if (draft || (ripple && host === "premiere")) {
        const base = draft ?? (await openDraft(context));
        return saveDraft(host, setDraftSpeed(base, draftIdFor(base, clipId), speed, ripple));
      }
      return edit(ctx(), "set_clip_speed", "set_clip_speed", { itemId: clipId, speed, ripple }, (r) => {
        const line = describeTimelineChange(r.changes[0]);
        return `${upper(line)}${host === "premiere" ? " (with its linked clips)" : " (its linked sound follows)"}`;
      });
    },

    set_speed_ramp: async (args) => {
      const clipId = optStr(args, "clipId");
      if (!clipId) throw new Error("clipId must be a timeline clip id");
      const changes = changesArg(args);
      const ease = optNum(args, "easeSeconds") ?? 0;
      if (!(ease >= 0 && ease <= 30)) throw new Error("easeSeconds must be from 0 to 30");
      const base = draftOf(host) ?? (await openDraft(context));
      const outcome = saveDraft(host, setDraftSpeedRamp(base, draftIdFor(base, clipId), changes, ease, bool(args, "ripple", true)));
      return { ...outcome, summary: `${outcome.summary}. It's in the draft: send_to_${host} builds it as a new ${TIMELINE_NOUN[host]}, the ramp as pieces at constant speeds` };
    },

    clear_clip_speed: async (args) => {
      const clipId = optStr(args, "clipId");
      if (!clipId) throw new Error("clipId must be a timeline clip id");
      const ripple = bool(args, "ripple", true);
      const draft = draftOf(host);
      if (draft) return saveDraft(host, setDraftSpeed(draft, draftIdFor(draft, clipId), 1, ripple));
      return executors.set_clip_speed({ clipId, speed: 1, ripple });
    },

    set_transition: async (args) => {
      const kind = optStr(args, "kind");
      if (kind !== "dissolve" && kind !== "dipToBlack" && kind !== "none") throw new Error('kind must be "dissolve", "dipToBlack" or "none"');
      const clipId = optStr(args, "clipId");
      if (!clipId) throw new Error("clipId must be a timeline clip id");
      const seconds = optNum(args, "seconds");
      return edit(direct("change a transition"), "set_transition", "set_transition", { itemId: clipId, kind, ...(seconds !== undefined ? { seconds } : {}) }, (r) => upper(describeTimelineChange(r.changes[0])));
    },

    add_track: async (args) => {
      const count = optNum(args, "count") ?? 1;
      return edit(direct("add a track"), "add_track", "add_track", { type: trackType(args), count }, (r) => `Added track${(r.addedTracks?.length ?? 0) > 1 ? "s" : ""} ${(r.addedTracks ?? []).join(", ")}`);
    },

    remove_track: async (args) => {
      const index = optNum(args, "index");
      return edit(direct("remove a track"), "remove_track", "remove_track", { type: trackType(args), ...(index !== undefined ? { index } : {}) }, (r) => describeTimelineChange(r.changes[0]));
    },

    set_track_options: async (args) => {
      const type = trackType(args);
      const index = num(args, "index");
      const options: Record<string, boolean> = {};
      for (const key of OPTIONS) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== "boolean") throw new Error(`${key} must be true or false`);
        options[key] = args[key] as boolean;
      }
      if (Object.keys(options).length === 0) throw new Error(`Give at least one of ${OPTIONS.filter((o) => o !== "soloed").join(", ")}`);
      if (options.soloed !== undefined) throw new Error(`${editor}'s scripting can't solo a track; ask the user to solo it in ${editor}`);
      return edit(direct("switch a track"), "set_track_options", "set_track_options", { type, index, options }, (r) => upper(describeTimelineChange(r.changes[0])));
    },
  };
  return executors;
}

export function timingInstruction(host: NleHost): string {
  return `- Speed, transitions and tracks: set_clip_speed (constant speed; ripple=true lets the clip get longer or
  shorter and moves everything after it${host === "premiere" ? ", which Premiere does in a draft" : ""}), set_transition (a dissolve or dip to black on a
  cut, or none to remove one), add_track and remove_track (the last empty one), set_track_options (switch a
  track on/off${host === "premiere" ? ", mute, lock, target, sync lock" : " or lock it, on the timeline open in Resolve"}). Split first (split_clip) to treat part of a clip
  differently. These are direct edits with the backup and Revert.
- Speed ramps: set_speed_ramp (speed changes partway through a clip, eased or sudden; a slow-motion moment,
  a speed-up through a dull stretch) works in the draft and is sent as pieces at constant speeds; clear_clip_speed
  puts a clip back to normal speed.`;
}
