/**
 * Colour (PLAN.md, "Phase 19c"): `set_clip_color` sets a clip's look, `match_clip_color` makes clips match
 * a reference as the editor shows them, `balance_clip_color` (Phase 20b) takes each clip to its own
 * neutral (match_clip_color's command with balance), and `get_clip_color` measures clips. A look is Lumetri's Basic
 * Correction in its units (exposure, contrast, temperature, tint, saturation): Premiere's Lumetri Color
 * itself, and in Resolve a CDL on node 1 calibrated to move the picture about as far
 * (src-python/vibecut_agent/nle/colour.py).
 *
 * set and match are direct edits through `edit()`: a backup, the edit log and Revert (Premiere puts the
 * Lumetri values back; Resolve copies the grade back from the backup). Reached through editExecutors, so
 * they're refused while a draft is open.
 */
import { nleCall } from "../ipc";
import type { NleHost } from "../../types/nle";
import { type Args, type Executor, optNum, optStr, strArray } from "./args";
import { COLOUR_FIELDS, count, describeColour, describeTimelineChange, edit, TIMELINE_NOUN, type EditContext } from "./edits";
import { learnedStyle, styleLook } from "./styles";
import type { ToolDeclaration } from "./tools";

const clipIdArg = { type: "STRING", description: "A timeline clip id from the snapshot (a picture clip)." };

export interface MeasuredClip {
  itemId: string;
  name: string;
  at: number;
  brightness: number;
  contrast: number;
  warmth: number;
  tint: number;
  colour: number;
  look?: Record<string, number>;
}

/** A measured frame in words, for the chat: "brightness 0.42, warm, slightly green, colour 0.21". */
export function describeMeasure(m: Pick<MeasuredClip, "brightness" | "contrast" | "warmth" | "tint" | "colour">): string {
  const cast = (value: number, plus: string, minus: string) => (Math.abs(value) < 0.03 ? null : `${Math.abs(value) < 0.1 ? "slightly " : ""}${value > 0 ? plus : minus}`);
  return [`brightness ${m.brightness.toFixed(2)}`, `contrast ${m.contrast.toFixed(2)}`, cast(m.warmth, "warm", "cool"), cast(m.tint, "green", "magenta"), `colourfulness ${m.colour.toFixed(2)}`]
    .filter(Boolean)
    .join(", ");
}

export function colorToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const where =
    host === "premiere"
      ? "the clip's Lumetri Color Basic Correction (added if the clip has none; its other Lumetri controls are left alone)"
      : "a CDL on the clip's node 1 in Resolve, calibrated to Lumetri's units (it replaces node 1's primaries; the clip's other nodes stay)";
  const revert = host === "premiere" ? "Revert puts the Lumetri values back." : "Revert copies the clip's grade back from the backup timeline (undoing any later grading of that clip too).";
  return [
    {
      name: "set_clip_color",
      description: `Sets picture clips' colour on the open ${noun}: ${where}. Units are Lumetri's: exposure in stops (-4 to 4), contrast -100 to 100, temperature -100 (cool) to 100 (warm), tint -100 (green) to 100 (magenta), saturation 0 to 200 (100 as shot). Values are the whole correction: fields left out are neutral. For a change relative to what's there ("a bit warmer"), read get_clip_color first${host === "premiere" ? " (its look is the current Lumetri values)" : " and the edit log's last colour change for the clip"}. Small steps look natural: exposure ±0.3, temperature ±10. A backup copy is made first; ${revert}`,
      parameters: {
        type: "OBJECT",
        properties: {
          looks: {
            type: "ARRAY",
            description: "One entry per clip.",
            items: {
              type: "OBJECT",
              properties: {
                itemId: clipIdArg,
                ...Object.fromEntries(COLOUR_FIELDS.map((k) => [k, { type: "NUMBER", description: "Optional." }])),
              },
              required: ["itemId"],
            },
          },
        },
        required: ["looks"],
      },
    },
    {
      name: "match_clip_color",
      description: `Makes clips' colour match a reference clip as ${host === "premiere" ? "Premiere" : "Resolve"} shows it (grade included): it measures a frame of each, sets ${where}, renders it and measures again, up to 3 passes, keeping the closest. It matches overall brightness, contrast, warmth, tint and colourfulness, so it's for shots of the same scene (two cameras on one interview, takes in one light), not different places. The reference isn't changed. Instead of referenceId, style (learned with learn_style) brings the clips toward that reference edit's average look: the overall feel, not a shot-for-shot grade, and kept moderate (exposure ±1, contrast ±40, temperature ±50, tint ±30, saturation 60-140), so a clip far from it gets closer, not all the way; say so when the distance stays high. The result says how close each got. A backup copy is made first; ${revert}`,
      parameters: {
        type: "OBJECT",
        properties: {
          referenceId: clipIdArg,
          style: { type: "STRING", description: "A style learned with learn_style, instead of referenceId." },
          clipIds: { type: "ARRAY", items: { type: "STRING" }, description: "The picture clips to change (up to 50)." },
        },
        required: ["clipIds"],
      },
    },
    {
      name: "balance_clip_color",
      description: `Balances picture clips each on its own, with no reference: it measures a frame of each as ${host === "premiere" ? "Premiere" : "Resolve"} shows it, then sets ${where} so what's grey in the shot (its least colourful third) has no colour cast, and the exposure is in a normal range (brightness 0.3-0.5; a shot already inside keeps its brightness, so a night scene stays dark). Only exposure, temperature and tint move: ${host === "premiere" ? "the clip's own contrast and saturation are kept" : "contrast and saturation are left neutral"}. A clip already balanced is left alone. It renders and measures again, keeping the closest pass. A shot with nothing near grey in it (a colour card, a stage in coloured light) is refused; a scene whose greys aren't really grey (a sunset) can be read wrong: check it after. Corrections stay within exposure ±2, temperature and tint ±60. For a scene, balance one shot, check it, then match_clip_color the others to it. A backup copy is made first; ${revert}`,
      parameters: {
        type: "OBJECT",
        properties: { clipIds: { type: "ARRAY", items: { type: "STRING" }, description: "The picture clips to balance (up to 50)." } },
        required: ["clipIds"],
      },
    },
    {
      name: "get_clip_color",
      description: `Measures picture clips as ${host === "premiere" ? "Premiere" : "Resolve"} shows them (a frame not under a clip on a higher track): brightness (mean luma 0-1; about 0.4 is a normal exposure), contrast (luma spread over its mean), warmth (ln R/B; above 0 warm), tint (ln G over R and B; above 0 green), colourfulness. ${host === "premiere" ? "Also each clip's current Lumetri look. " : ""}Use it before judging or changing colour. Only reads; the playhead is put back.`,
      parameters: { type: "OBJECT", properties: { clipIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["clipIds"] },
    },
  ];
}

export function colorExecutors(ctx: EditContext): Record<string, Executor> {
  return {
    set_clip_color: async (args) => {
      const raw = args.looks;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("looks must be a non-empty array of {itemId, exposure, contrast, temperature, tint, saturation}");
      const looks = raw.map((value, i) => {
        const entry = (value ?? {}) as Args;
        const itemId = optStr(entry, "itemId");
        if (!itemId) throw new Error(`looks[${i}].itemId must be a timeline clip id`);
        const out: Record<string, unknown> = { itemId };
        for (const key of COLOUR_FIELDS) {
          const n = optNum(entry, key);
          if (n !== undefined) out[key] = n;
        }
        if (Object.keys(out).length === 1) throw new Error(`looks[${i}] must give exposure, contrast, temperature, tint or saturation`);
        return out;
      });
      return edit(ctx, "set_clip_color", "set_clip_color", { looks }, (r) => `Set the colour of ${count(r.changes.length, "clip")}: ${r.changes.map((c) => describeTimelineChange(c)).join("; ")}`);
    },

    match_clip_color: async (args) => {
      const referenceId = optStr(args, "referenceId");
      const style = optStr(args, "style");
      if (referenceId && style) throw new Error("Give referenceId (a clip) or style (a learned style), not both");
      if (!referenceId && !style) throw new Error("referenceId must be the timeline clip to match (or style, a learned style)");
      const itemIds = strArray(args, "clipIds");
      const reference = style ? { referenceLook: styleLook(await learnedStyle(ctx.host, style)) } : { referenceId };
      const to = style ? `the "${style}" style` : "the reference";
      return edit(ctx, "match_clip_color", "match_clip_color", { ...reference, itemIds }, (r) => `Matched ${count(r.changes.length, "clip")} to ${to}: ${r.changes.map((c) => describeTimelineChange(c)).join("; ")}`);
    },

    balance_clip_color: async (args) =>
      edit(ctx, "balance_clip_color", "match_clip_color", { balance: true, itemIds: strArray(args, "clipIds") }, (r) => `Balanced ${count(r.changes.length, "clip")}: ${r.changes.map((c) => describeTimelineChange(c)).join("; ")}`),

    get_clip_color: async (args) => {
      const read = await nleCall<{ clips: MeasuredClip[]; refused: { reason: string }[] }>(ctx.host, "read_clip_color", { timeline: ctx.timeline, itemIds: strArray(args, "clipIds") });
      const lines = read.clips.map((c) => `"${c.name}": ${describeMeasure(c)}${c.look ? `; Lumetri ${describeColour(c.look)}` : ""}`);
      if (read.refused.length) lines.push(...read.refused.map((r) => r.reason));
      return { summary: lines.join("; "), result: read };
    },
  };
}

/** The ground rule the system prompt gains (Phase 19c). */
export const COLOR_INSTRUCTION = `- Colour: get_clip_color measures what the viewer shows; set_clip_color sets exposure, contrast,
  temperature, tint and saturation (Lumetri's units, the whole correction); match_clip_color matches
  shots of one scene to a reference; balance_clip_color takes a shot's cast out and its exposure into a
  normal range with no reference ("fix the white balance", "balance these"). Measure before and after, change in small steps, and say what
  changed in plain words. Creative looks, LUTs, secondaries and masks are beyond these tools: say so.`;
