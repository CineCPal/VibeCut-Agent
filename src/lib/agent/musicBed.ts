/**
 * A music bed under a Story Editor cut (PLAN.md, "Phase 16d"), after VibeCut's storyEditorActions.ts
 * and musicActions.ts: the cut's main edit points are snapped to the music's beats (musicSync.ts,
 * verbatim), then the music goes on a new audio track of the draft from the cut's start, trimmed to the
 * cut (no stretching or looping), at a bed level under the voices. VibeCut found the beats with its own
 * onset detector; here it's the `media-beats` job (Phase 13d), whose beats are what cut_to_beats uses.
 *
 * Differences from VibeCut: the bed goes into the draft, so it reaches the editor with send_to_*; a fade
 * isn't carried by the rebuild (OTIO records fades as metadata only), so the agent fades the music's end
 * with set_clip_fade after sending.
 */
import { runJob } from "../jobs";
import type { DraftClip, HostDraft } from "../../vibecut/lib/connect/hostDraft";
import { snapPlanToBeats } from "../../vibecut/lib/musicSync";
import type { RoughCutPlan } from "../../vibecut/lib/sidecarResults";

/** Below the voices without vanishing: a usual level for a bed under interview. */
export const DEFAULT_BED_DB = -18;
export const MIN_BED_DB = -40;
export const MAX_BED_DB = 0;
/** Under this the music has no steady pulse (find_beats says the same), so cuts aren't snapped to it. */
export const MIN_BEAT_CONFIDENCE = 0.3;

export interface MusicBeats {
  path: string;
  bpm: number | null;
  confidence: number;
  /** Seconds into the file. */
  beats: number[];
  /** The music's length, as far as it was read. */
  duration: number;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const snap = (seconds: number, fps: number) => Math.round(seconds * fps) / fps;
const round3 = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** The beat finder reads at most 20 minutes at once; no story cut needs a longer bed. */
const MAX_BED_SECONDS = 20 * 60;

/** The music's tempo, beats and length (up to 20 minutes), from the `media-beats` job. */
export async function musicBeats(path: string): Promise<MusicBeats> {
  const job = await runJob("media-beats", `Find the beats of "${fileName(path)}"`, { path, start: 0, end: MAX_BED_SECONDS });
  const found = job?.result as { bpm: number | null; confidence: number; beats: number[]; end?: number } | undefined;
  if (!found) throw new Error(`The music couldn't be read: ${job?.error ?? "the beat finder didn't finish"}`);
  const duration = typeof found.end === "number" && found.end > 0 ? found.end : Math.max(0, ...found.beats);
  return { path, bpm: found.bpm, confidence: found.confidence, beats: [...found.beats].sort((a, b) => a - b), duration };
}

/** Snaps the plan's main cuts to the beats when the music has a steady pulse. `moved` counts the cuts
 * that moved; `skipped` says why nothing was snapped. The music starts with the cut, so file time and
 * cut time are the same. The first main cut stays where the piece starts: snapping it to a first beat a
 * frame in left black at the head (seen live, Phase 16d). Keeping it earlier only lowers the floor the
 * later cuts were clamped to, so nothing can overlap. */
export function snapToMusic(plan: RoughCutPlan, music: MusicBeats): { plan: RoughCutPlan; moved: number; skipped?: string } {
  if (music.confidence < MIN_BEAT_CONFIDENCE || music.beats.length === 0) {
    return { plan, moved: 0, skipped: `the music has no steady beat (confidence ${music.confidence.toFixed(2)}), so the cuts weren't moved` };
  }
  const first = plan.segments.findIndex((s) => s.track === "main");
  const beaten = snapPlanToBeats(plan, music.beats);
  const snapped = first < 0 ? beaten : { ...beaten, segments: beaten.segments.map((s, i) => (i === first ? plan.segments[i] : s)) };
  const moved = snapped.segments.filter((s, i) => s.start !== plan.segments[i].start).length;
  return { plan: snapped, moved };
}

/** Puts the music on a new audio track (below the cut's own sound) from 0, as long as the cut or the
 * music, whichever is shorter. */
export function addMusicBed(draft: HostDraft, music: MusicBeats, volumeDb: number): { draft: HostDraft; length: number; shorterThanCut: boolean; track: string } {
  if (!(volumeDb >= MIN_BED_DB && volumeDb <= MAX_BED_DB)) throw new Error(`musicLevelDb must be from ${MIN_BED_DB} to ${MAX_BED_DB}`);
  const length = snap(Math.min(music.duration, draft.duration), draft.fps);
  if (!(length > 0)) throw new Error("The music or the cut has no length to place a bed against");
  const clip: DraftClip = {
    sourcePath: music.path,
    sourceName: fileName(music.path),
    start: 0,
    end: length,
    sourceIn: 0,
    sourceOut: round3(length),
    speed: 1,
    enabled: true,
    volumeDb,
  };
  const audio = [...draft.audio, { type: "audio" as const, clips: [clip] }];
  const track = `A${audio.length}`;
  const shorterThanCut = music.duration < draft.duration - 0.5 / draft.fps;
  return {
    draft: {
      ...draft,
      audio,
      changes: [...draft.changes, `Music bed ${clip.sourceName} on ${track} at ${volumeDb} dB, ${round3(length)}s${shorterThanCut ? " (shorter than the cut)" : ""}`],
    },
    length,
    shorterThanCut,
    track,
  };
}
