/**
 * The agent's direct-edit tools (PLAN.md, Phase 4b), ported from VibeCut's timelineEdits.ts,
 * hostNesting.ts, hostAudio.ts and the reshape tools in premiereChatTools.ts / resolveChatTools.ts.
 * VibeCut's drafts, Media Pool ids and editor selection don't exist here, so ripple edits are refused,
 * clips are added by file path, and fades name their clips.
 */
import { nleCall } from "../ipc";
import { lastEditStep } from "../../store/useEditLogStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { bool, clock, num, optNum, optStr, strArray, type Args, type Executor } from "./args";
import { duckMusic } from "./duck";
import { count, describeTimelineChange, edit, readTimeline, revertTimelineEdits, TIMELINE_NOUN, type EditContext } from "./edits";
import type { ToolDeclaration } from "./tools";

const itemIdsArg = { type: "ARRAY", items: { type: "STRING" }, description: "Timeline clip ids from the snapshot." };
const clipIdArg = { type: "STRING", description: "A timeline clip id from the snapshot." };

export function editToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const DIRECT = `Changes the open ${noun} itself (a backup copy is made first for each request); it can be reverted.`;
  const RESHAPE_NOTE =
    host === "premiere"
      ? `It changes the clip on the ${noun} itself, in place, with its linked picture or sound (its effects stay on it); clips with a speed change or a transition at an edge are refused. Nothing is overwritten: the new range must be free. ${DIRECT}`
      : `It changes the ${noun} by replacing the clip (and its linked sound) with the same media at the new range; its grade, transform, fades, colour, level and Fusion comps are carried, keyframes aren't, and clips with a speed change or a transition at an edge are refused. Nothing is overwritten: the new range must be free. ${DIRECT}`;
  return [
    {
      name: "add_clips",
      description: `Places parts of media files (path) on the open ${noun} in free space: picture and sound linked, on the lowest track that's free there unless videoTrack/audioTrack is given (when none is free, a new track is added at the end; Revert removes it again). It never overwrites: an occupied place on a track you name is refused, so leave videoTrack/audioTrack out unless the user named a track. picture/sound false leaves that part out. ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clips: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                path: { type: "STRING", description: "Absolute media file path." },
                sourceIn: { type: "NUMBER", description: "Seconds into the file. Default 0." },
                sourceOut: { type: "NUMBER", description: "Seconds into the file; after sourceIn." },
                at: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` },
                videoTrack: { type: "NUMBER", description: "1-based. Optional." },
                audioTrack: { type: "NUMBER", description: "1-based: where its first channel goes. Optional." },
                picture: { type: "BOOLEAN", description: "Optional; default true when the file has picture." },
                sound: { type: "BOOLEAN", description: "Optional; default true when the file has sound." },
                volumeDb: { type: "NUMBER", description: "Level of its sound. Optional." },
              },
              required: ["path", "sourceOut", "at"],
            },
          },
        },
        required: ["clips"],
      },
    },
    {
      name: "delete_clips",
      description: `Lifts clips off the open ${noun}, leaving gaps (no ripple). Their linked picture or sound goes too unless withLinked is false. Transitions can't be removed here. ${DIRECT}`,
      parameters: { type: "OBJECT", properties: { itemIds: itemIdsArg, withLinked: { type: "BOOLEAN", description: "Optional; default true." } }, required: ["itemIds"] },
    },
    {
      name: "set_clips_enabled",
      description: `Switches clips on the open ${noun} on or off (an off clip stays in place but doesn't play). ${DIRECT}`,
      parameters: { type: "OBJECT", properties: { itemIds: itemIdsArg, enabled: { type: "BOOLEAN" } }, required: ["itemIds", "enabled"] },
    },
    {
      name: "set_clip_levels",
      description: `Sets sound clips' level in dB (-100 to +30; 0 is unchanged). A picture clip's id sets its linked sound.${host === "premiere" ? " Clips with level keyframes are refused." : ""} ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          levels: { type: "ARRAY", items: { type: "OBJECT", properties: { itemId: { type: "STRING" }, volumeDb: { type: "NUMBER" } }, required: ["itemId", "volumeDb"] } },
        },
        required: ["levels"],
      },
    },
    {
      name: "set_clip_fade",
      description: `Fades clips in from (or out to) black, or silence for sound: which is fadeIn or fadeOut, seconds its length (0 removes it). A picture and its sound fade separately, so give both ids to fade both. It is cut shorter to fit the clip with its other fade (the reply says so). ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: { clipIds: itemIdsArg, which: { type: "STRING", enum: ["fadeIn", "fadeOut"] }, seconds: { type: "NUMBER" } },
        required: ["clipIds", "which", "seconds"],
      },
    },
    {
      name: "split_clip",
      description: `Cuts clips in two at a time (like the razor), with their linked picture or sound: clipIds, else every clip under the time; time defaults to ${host === "premiere" ? "Premiere" : "Resolve"}'s playhead. Both pieces keep the clip's look. Use it before treating part of a clip differently (a level, deleting part). ${DIRECT}`,
      parameters: {
        type: "OBJECT",
        properties: { clipIds: itemIdsArg, time: { type: "NUMBER", description: `Seconds from the ${noun}'s start. Optional.` } },
      },
    },
    {
      name: "trim_clip_start",
      description: `Trims the start of a clip to a new point in its source (seconds into the source); the clip's out point stays. ${RESHAPE_NOTE}`,
      parameters: { type: "OBJECT", properties: { clipId: clipIdArg, rawSourceIn: { type: "NUMBER" } }, required: ["clipId", "rawSourceIn"] },
    },
    {
      name: "trim_clip_end",
      description: `Trims the end of a clip to a new point in its source (seconds into the source). ${RESHAPE_NOTE}`,
      parameters: { type: "OBJECT", properties: { clipId: clipIdArg, rawSourceOut: { type: "NUMBER" } }, required: ["clipId", "rawSourceOut"] },
    },
    {
      name: "slip_clip",
      description: `Slips a clip: shows a different part of its source (delta seconds; negative is earlier) while it stays in place, same length. ${RESHAPE_NOTE}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: clipIdArg,
          delta: { type: "NUMBER" },
          withLinked: { type: "BOOLEAN", description: "Optional, default true. false slips only this sound clip (with the other channels of its recording), leaving its linked picture: for putting sound back in sync." },
        },
        required: ["clipId", "delta"],
      },
    },
    {
      name: "move_clip",
      description:
        host === "premiere"
          ? `Moves a clip (with its linked sound) to a new start time, optionally a picture clip to another video track (1-based; the next new track is added if needed). Changing track places the picture there again from its project item, so a clip with effects, keyframes or changed Motion/Opacity is refused, and sound can't change track. ${RESHAPE_NOTE}`
          : `Moves a clip (with its linked sound) to a new start time, optionally to another track of its kind (1-based track). ${RESHAPE_NOTE}`,
      parameters: { type: "OBJECT", properties: { clipId: clipIdArg, startTime: { type: "NUMBER" }, track: { type: "NUMBER", description: "Optional." } }, required: ["clipId", "startTime"] },
    },
    {
      name: "nest_clips",
      description: `Nests a stretch of the ${noun}: every clip from start to end, on every track, becomes one clip in their place (${host === "premiere" ? "a nested sequence on V1/A1; the sequence must be the one open in Premiere" : "a compound clip"}). Give start and end, or clipIds to nest the stretch they and their linked clips cover. A clip running across either edge is refused: split it there first (split_clip). The editor can't un-nest from a script; Revert takes the nest out and puts the clips back from their files (effects and grades on them aren't restored).`,
      parameters: {
        type: "OBJECT",
        properties: {
          start: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` },
          end: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` },
          clipIds: { type: "ARRAY", items: { type: "STRING" }, description: "Instead of start/end: the clips whose stretch to nest." },
          name: { type: "STRING", description: 'The nest\'s name. Default "Nested clips".' },
        },
      },
    },
    {
      name: "duck_music",
      description: `Turns music down under dialogue, ramping down before each stretch and back up after. Dialogue is where the dialogue clips sit (dialogueClipIds; default every other sound clip), or the spans you give; there are no transcripts, so pauses inside a clip aren't found. ${host === "premiere" ? "Premiere: Level keyframes on the music clip, keeping its fades (refused if it already has other Level keyframes; revert an earlier duck first)." : "Resolve has no audio keyframes, so the music is cut at each dip, the pieces under dialogue turned down and each cut crossfaded."} Revertable. Do it after the cut, fades and levels are settled.`,
      parameters: {
        type: "OBJECT",
        properties: {
          musicClipIds: { type: "ARRAY", items: { type: "STRING" }, description: "Timeline ids of the music clips (sound clips)." },
          dialogueClipIds: { type: "ARRAY", items: { type: "STRING" }, description: "Sound clips with speech. Optional." },
          spans: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" } }, required: ["start", "end"] },
            description: `Instead of dialogue clips: seconds from the ${noun}'s start to duck under. Optional.`,
          },
          duckDb: { type: "NUMBER", description: "How far down, -40 to -1 dB. Default -12." },
          rampSeconds: { type: "NUMBER", description: "Ramp length, 0.05 to 2. Default 0.3." },
          leadSeconds: { type: "NUMBER", description: "Start ducking this long before dialogue. Default 0.2." },
          tailSeconds: { type: "NUMBER", description: "Stay down this long after. Default 0.4." },
          bridgeSeconds: { type: "NUMBER", description: "Stay down through gaps shorter than this. Default 1." },
        },
        required: ["musicClipIds"],
      },
    },
    {
      name: "revert_timeline_edits",
      description: `Undoes your earlier direct edits: editIds (the editId each result gave, e.g. "e2"), or lastStep=true for everything you edited for the latest request. A clip changed since is left as it is. ${host === "premiere" ? "A deleted clip comes back from its file without its effects; the backup still has them. Trims, slips and moves go back with the clip's effects." : "A deleted clip comes back from its source with its grade from the backup when it can; the backup timeline keeps everything."}`,
      parameters: { type: "OBJECT", properties: { editIds: { type: "ARRAY", items: { type: "STRING" } }, lastStep: { type: "BOOLEAN" } } },
    },
  ];
}

function clipSpec(raw: unknown, i: number): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new Error(`clips[${i}] must be an object`);
  const c = raw as Args;
  const path = optStr(c, "path");
  if (!path) throw new Error(`clips[${i}]: give path, an absolute media file path`);
  const spec: Record<string, unknown> = { path, at: num(c, "at"), sourceIn: optNum(c, "sourceIn") ?? 0, sourceOut: num(c, "sourceOut") };
  for (const key of ["videoTrack", "audioTrack", "volumeDb"] as const) {
    const value = optNum(c, key);
    if (value !== undefined) spec[key] = value;
  }
  for (const key of ["picture", "sound"] as const) if (typeof c[key] === "boolean") spec[key] = c[key];
  return spec;
}

/** Places clips (the agent's add_clips, and the B-roll panel's Place). */
export function addClips(ctx: EditContext, tool: string, clips: Record<string, unknown>[]) {
  return edit(ctx, tool, "add_clips", { clips }, (r) => {
    const placed = r.changes.map((c) => `"${c.name}" at ${clock(c.at ?? 0)} on ${(c.tracks ?? []).join("+")}`);
    return `Added ${count(r.changes.length, "clip")} to the ${TIMELINE_NOUN[ctx.host]}: ${placed.join(", ")}${r.addedTracks?.length ? `; new track(s) ${r.addedTracks.join(", ")}` : ""}`;
  });
}

const ids = (args: Args) => strArray(args, "itemIds");

/** The range a nest covers: given, else the span of `clipIds` and the clips linked to them. */
export function nestRange(args: Args, view: HostTimeline): { start: number; end: number } {
  const start = optNum(args, "start");
  const end = optNum(args, "end");
  if (start !== undefined && end !== undefined) return { start, end };
  const wantedIds = Array.isArray(args.clipIds) ? (args.clipIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
  if (!wantedIds.length) throw new Error("Give start and end (seconds), or clipIds to nest the stretch they cover");
  const clips = view.tracks.flatMap((t) => t.clips);
  const wanted = new Set(wantedIds);
  for (const c of clips) if (wanted.has(c.id)) for (const l of c.linkedIds ?? []) wanted.add(l);
  const missing = wantedIds.filter((id) => !clips.some((c) => c.id === id));
  if (missing.length) throw new Error(`There's no clip ${missing.join(", ")} on the open timeline`);
  const chosen = clips.filter((c) => wanted.has(c.id));
  return { start: Math.min(...chosen.map((c) => c.start)), end: Math.max(...chosen.map((c) => c.end)) };
}

export function editExecutors(ctx: EditContext): Record<string, Executor> {
  const noun = TIMELINE_NOUN[ctx.host];

  const reshape = (tool: string, args: Args, shape: Record<string, unknown>) => async () => {
    if (args.ripple === true) throw new Error("Ripple edits aren't available in this version; trim without ripple, or ask the user to ripple in the editor");
    const clipId = optStr(args, "clipId");
    if (!clipId) throw new Error("clipId must be a timeline clip id");
    const request: Record<string, unknown> = { itemId: clipId, ...shape };
    if (tool === "slip_clip" && args.withLinked === false) request.withLinked = false;
    const track = optNum(args, "track");
    if (track !== undefined) {
      const view = await readTimeline(ctx);
      const kind = view.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.type;
      request[kind === "audio" ? "audioTrack" : "videoTrack"] = track;
    }
    return edit(ctx, tool, "reshape_clip", request, (r) => {
      const change = r.changes[0];
      const line = change ? describeTimelineChange(change) : "Reshaped the clip";
      const alone = request.withLinked === false ? "the sound alone; its picture stays where it is" : null;
      const kept =
        ctx.host === "resolve"
          ? `${alone ? `${alone}, still linked; ` : ""}grade, transform, fades and level carried`
          : change?.retracked
            ? `placed again from its project item on the new track, with its sound still linked${r.addedTracks?.length ? `; new track ${r.addedTracks.join(", ")}` : ""}`
            : `in place, ${alone ?? "with its linked clips"}; its effects stay on it`;
      return `${line.charAt(0).toUpperCase()}${line.slice(1)} (${kept})`;
    });
  };

  return {
    add_clips: async (args) => {
      if (!Array.isArray(args.clips) || args.clips.length === 0) throw new Error("clips must be a non-empty array");
      return addClips(ctx, "add_clips", (args.clips as unknown[]).map(clipSpec));
    },

    delete_clips: async (args) =>
      edit(ctx, "delete_clips", "delete_clips", { itemIds: ids(args), withLinked: args.withLinked !== false }, (r) => {
        const names = [...new Set(r.changes.map((c) => c.name))];
        return `Removed ${count(r.changes.length, "clip")} from the ${noun}, leaving gaps (${names.join(", ")})`;
      }),

    set_clips_enabled: async (args) => {
      const enabled = bool(args, "enabled", true);
      return edit(ctx, "set_clips_enabled", "set_clips_enabled", { itemIds: ids(args), enabled }, (r) => `Switched ${count(r.changes.length, "clip")} ${enabled ? "on" : "off"}`);
    },

    set_clip_levels: async (args) => {
      const levels = args.levels;
      if (!Array.isArray(levels) || levels.length === 0) throw new Error("levels must be a non-empty array of {itemId, volumeDb}");
      const request = levels.map((lv, i) => {
        if (typeof lv !== "object" || lv === null) throw new Error(`levels[${i}] must be an object`);
        const level = lv as Args;
        const itemId = optStr(level, "itemId");
        if (!itemId) throw new Error(`levels[${i}].itemId must be a timeline clip id`);
        return { itemId, volumeDb: num(level, "volumeDb") };
      });
      return edit(ctx, "set_clip_levels", "set_clip_levels", { levels: request }, (r) =>
        `Set the level of ${count(r.changes.length, "sound clip")}: ${r.changes.map((c) => `"${c.name}" ${String(c.before ?? 0)} → ${String(c.after)} dB`).join(", ")}`,
      );
    },

    set_clip_fade: async (args) => {
      const which = optStr(args, "which");
      if (which !== "fadeIn" && which !== "fadeOut") throw new Error('which must be "fadeIn" or "fadeOut"');
      const seconds = num(args, "seconds");
      if (seconds < 0) throw new Error("seconds can't be negative (0 removes the fade)");
      return edit(ctx, "set_clip_fade", "set_clip_fades", { itemIds: strArray(args, "clipIds"), which, seconds }, (r) => {
        const clamped = r.changes.some((c) => c.clamped);
        return `Set the ${which === "fadeIn" ? "fade in" : "fade out"} of ${count(r.changes.length, "clip")} to ${clock(seconds)}${clamped ? " (cut shorter on some to fit the clip)" : ""}: ${r.changes.map((c) => `"${c.name}"`).join(", ")}`;
      });
    },

    split_clip: async (args) => {
      const time = optNum(args, "time") ?? (await nleCall<{ time: number }>(ctx.host, "get_playhead", { timeline: ctx.timeline })).time;
      let itemIds = args.clipIds === undefined ? [] : strArray(args, "clipIds");
      if (!itemIds.length) {
        const view = await readTimeline(ctx);
        itemIds = view.tracks.flatMap((t) => t.clips.filter((c) => c.kind !== "effect" && c.start < time - 1e-6 && c.end > time + 1e-6).map((c) => c.id));
        if (!itemIds.length) throw new Error(`No clip runs across ${clock(time)}; give clipIds and a time inside them`);
      }
      return edit(ctx, "split_clip", "split_clips", { itemIds, time }, (r) => {
        const lines = r.changes.map((c) => describeTimelineChange(c));
        return `${lines.join("; ").replace(/^./, (c) => c.toUpperCase())}${ctx.host === "premiere" ? "" : " (grade, transform, level and fades carried to both pieces)"}`;
      });
    },

    trim_clip_start: async (args) => reshape("trim_clip_start", args, { sourceIn: num(args, "rawSourceIn") })(),
    trim_clip_end: async (args) => reshape("trim_clip_end", args, { sourceOut: num(args, "rawSourceOut") })(),
    slip_clip: async (args) => reshape("slip_clip", args, { slip: num(args, "delta") })(),
    move_clip: async (args) => reshape("move_clip", args, { start: num(args, "startTime") })(),

    nest_clips: async (args) => {
      const { start, end } = nestRange(args, await readTimeline(ctx));
      const name = optStr(args, "name");
      const what = ctx.host === "premiere" ? "nested sequence" : "compound clip";
      return edit(ctx, "nest_clips", "nest_clips", { start, end, ...(name ? { name } : {}) }, (r) => {
        const added = r.changes.find((c) => c.kind === "added");
        const nested = r.changes.filter((c) => c.kind === "deleted").length;
        return `Nested ${count(nested, "clip")} from ${clock(start)} to ${clock(end)} into the ${what} "${added?.name ?? name ?? "Nested clips"}" on ${(added?.tracks ?? []).join("+")}`;
      });
    },

    duck_music: async (args) => duckMusic(ctx, args),

    revert_timeline_edits: async (args) => {
      const given = args.editIds === undefined ? [] : strArray(args, "editIds");
      const list = given.length ? given : bool(args, "lastStep") ? lastEditStep() : [];
      if (list.length === 0) throw new Error("Give editIds (from the earlier results) or lastStep=true");
      return revertTimelineEdits(list);
    },
  };
}
