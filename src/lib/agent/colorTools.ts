/**
 * Colour (PLAN.md, "Phase 19c"): `set_clip_color` sets a clip's look, `match_clip_color` makes clips match
 * a reference as the editor shows them, `balance_clip_color` (Phase 20b) takes each clip to its own
 * neutral (match_clip_color's command with balance), and `get_clip_color` measures clips. Matching to a
 * clip and balancing go by the histogram and RGB parade (Phase 20b, parade.py): a curve per channel
 * (Premiere's Levels effect, Resolve's per-channel CDL) and saturation. A look is Lumetri's Basic
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
  /** Phase 20b: each channel's and luma's levels at the 2nd, 10th, 25th, 50th, 75th, 90th and 98th
   * percentiles (parade.py `parade`). */
  parade?: { r: number[]; g: number[]; b: number[]; luma: number[] };
  look?: Record<string, number>;
}

/** The histogram and parade in words: "blacks 0.03, mids 0.41, whites 0.92, shadows cool, highlights
 * green" (a channel 0.03 or more off the others at the 10th or 90th percentile). */
export function describeParade(p: NonNullable<MeasuredClip["parade"]>): string {
  const parts = [`blacks ${p.luma[0].toFixed(2)}`, `mids ${p.luma[3].toFixed(2)}`, `whites ${p.luma[6].toFixed(2)}`];
  for (const [label, i] of [["shadows", 1], ["highlights", 5]] as const) {
    const warm = p.r[i] - p.b[i];
    const green = p.g[i] - (p.r[i] + p.b[i]) / 2;
    const casts = [Math.abs(warm) >= 0.03 ? (warm > 0 ? "warm" : "cool") : null, Math.abs(green) >= 0.03 ? (green > 0 ? "green" : "magenta") : null].filter(Boolean);
    if (casts.length) parts.push(`${label} ${casts.join(" and ")}`);
  }
  return parts.join(", ");
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
  const curves =
    host === "premiere"
      ? "the Levels effect's R, G and B controls (added if the clip has none; its RGB controls are left neutral)"
      : "a CDL on the clip's node 1 (slope, offset and power per channel; it replaces node 1's primaries; the clip's other nodes stay)";
  const saturation =
    host === "premiere" ? "Lumetri's Saturation (the clip's own, scaled; its other Lumetri controls are left alone)" : "the CDL's saturation";
  const shows = host === "premiere" ? "Premiere" : "Resolve";
  const revert = host === "premiere" ? "Revert puts the Lumetri and Levels values back." : "Revert copies the clip's grade back from the backup timeline (undoing any later grading of that clip too).";
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
      description: `Makes clips' colour match a reference clip as ${shows} shows it (grade included), by the histogram and the RGB parade: it measures three frames of each clip (a quarter, half and three quarters through), and fits a curve per channel (black, white and gamma) that takes each clip's red, green, blue and luma levels, from the 2nd to the 98th percentile, to the reference's, plus saturation for colourfulness. It sets ${curves} and ${saturation}, renders and measures again, up to 5 passes, keeping the closest. So black and white levels, contrast, and casts in the shadows or highlights alone are matched, not just averages. It's for shots of the same scene (two cameras on one interview, takes in one light), not different places, whose content would move the levels. The reference isn't changed. Instead of referenceId, style (learned with learn_style) brings the clips toward that reference edit's average look (five overall measures, set as ${where}): the overall feel, not a shot-for-shot grade, and kept moderate (exposure ±1, contrast ±40, temperature ±50, tint ±30, saturation 60-140), so a clip far from it gets closer, not all the way; say so when the distance stays high. The result says how close each got. A backup copy is made first; ${revert}`,
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
      description: `Balances picture clips each on its own, with no reference, by what should be neutral in the shot: for each clip, name 1 to 4 areas of its frame that are white, grey or black in life (a white card, a grey wall, a white shirt, pavement; not skin, sky or foliage), as fractions of the frame from its top left. First look at the frame (look_at_timeline at the clip's time; give that time as at) and read the areas off it; if nothing in the shot is neutral, or you can't tell, ask the user rather than guess (picking greys blind proved wrong). It measures that frame as ${shows} shows it and sets ${curves} so the areas' red, green and blue read alike, at every level when the areas span shadows to highlights (a cast in the shadows alone is taken out too), with the exposure in a normal range (brightness 0.3-0.5; a shot inside it keeps its brightness, so a night scene stays dark). Saturation isn't changed. A clip already balanced is left alone; an area that's strongly coloured, or clipped to black or white, is refused. It renders and measures again, keeping the closest pass. For a scene, balance one shot, check it, then match_clip_color the others to it. A backup copy is made first; ${revert}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clips: {
            type: "ARRAY",
            description: "One entry per clip (up to 50).",
            items: {
              type: "OBJECT",
              properties: {
                clipId: clipIdArg,
                at: { type: "NUMBER", description: `Optional; seconds on the ${noun}, inside the clip: the frame the areas were read from. Default its middle.` },
                neutral: {
                  type: "ARRAY",
                  description: "1 to 4 neutral areas, fractions of the frame (0-1) from its top left.",
                  items: {
                    type: "OBJECT",
                    properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, width: { type: "NUMBER" }, height: { type: "NUMBER" } },
                    required: ["x", "y", "width", "height"],
                  },
                },
              },
              required: ["clipId", "neutral"],
            },
          },
        },
        required: ["clips"],
      },
    },
    {
      name: "get_clip_color",
      description: `Measures picture clips as ${shows} shows them (a frame not under a clip on a higher track): brightness (mean luma 0-1; about 0.4 is a normal exposure), contrast (luma spread over its mean), warmth (ln R/B; above 0 warm), tint (ln G over R and B; above 0 green), colourfulness, and its histogram and RGB parade (parade: luma's and each channel's levels at the 2nd, 10th, 25th, 50th, 75th, 90th and 98th percentiles, blacks to whites; a channel above the others in the low ones is a cast in the shadows). ${host === "premiere" ? "Also each clip's current Lumetri look. " : ""}Use it before judging or changing colour. Only reads; the playhead is put back.`,
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

    balance_clip_color: async (args) => {
      const raw = args.clips;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("clips must be a non-empty array of {clipId, at?, neutral: [{x, y, width, height}]}");
      const items = raw.map((value, i) => {
        const entry = (value ?? {}) as Args;
        const itemId = optStr(entry, "clipId");
        if (!itemId) throw new Error(`clips[${i}].clipId must be a timeline clip id`);
        const neutral = entry.neutral;
        if (!Array.isArray(neutral) || neutral.length === 0) throw new Error(`clips[${i}].neutral must name 1 to 4 areas that are white, grey or black in the shot`);
        const areas = neutral.map((area, j) => {
          const box = (area ?? {}) as Args;
          return (["x", "y", "width", "height"] as const).map((k) => {
            const n = optNum(box, k);
            if (n === undefined) throw new Error(`clips[${i}].neutral[${j}].${k} must be a number (a fraction of the frame)`);
            return n;
          });
        });
        const at = optNum(entry, "at");
        return { itemId, ...(at !== undefined ? { at } : {}), areas };
      });
      return edit(ctx, "balance_clip_color", "match_clip_color", { balance: true, items }, (r) => `Balanced ${count(r.changes.length, "clip")}: ${r.changes.map((c) => describeTimelineChange(c)).join("; ")}`);
    },

    get_clip_color: async (args) => {
      const read = await nleCall<{ clips: MeasuredClip[]; refused: { reason: string }[] }>(ctx.host, "read_clip_color", { timeline: ctx.timeline, itemIds: strArray(args, "clipIds") });
      const lines = read.clips.map((c) => `"${c.name}": ${describeMeasure(c)}${c.parade ? `; ${describeParade(c.parade)}` : ""}${c.look ? `; Lumetri ${describeColour(c.look)}` : ""}`);
      if (read.refused.length) lines.push(...read.refused.map((r) => r.reason));
      return { summary: lines.join("; "), result: read };
    },
  };
}

/** The ground rule the system prompt gains (Phase 19c). */
export const COLOR_INSTRUCTION = `- Colour: get_clip_color measures what the viewer shows; set_clip_color sets exposure, contrast,
  temperature, tint and saturation (Lumetri's units, the whole correction); match_clip_color matches
  shots of one scene to a reference by the histogram and RGB parade (curves per channel, so blacks,
  whites and casts in the shadows or highlights match too); balance_clip_color makes what's neutral in
  a shot (areas you name after looking at the frame: a white card, a grey wall) read neutral and its
  exposure normal, with no reference ("fix the white balance", "balance these"); with nothing neutral
  in the shot, ask the user. Measure before and after, change in small steps, and say what
  changed in plain words. Creative looks, LUTs, secondaries and masks are beyond these tools: say so.`;
