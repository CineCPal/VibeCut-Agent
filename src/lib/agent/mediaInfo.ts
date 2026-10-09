/**
 * The technical facts of the files heard on a timeline (PLAN.md, "Phase 13a"): codec, frame size, rate,
 * audio channels and length, read once per file per session by the `media-info` job
 * (vibecut_agent/media/info.py) and shown in the snapshot's [SOURCES] lines.
 *
 * The snapshot never waits long for them: files not read yet are probed for up to PROBE_WAIT_MS, and
 * whatever isn't back by then shows on a later message.
 */
import { runJob } from "../jobs";
import type { HostTimeline } from "../../types/timeline";

export interface MediaFacts {
  duration: number | null;
  video: { codec: string | null; width: number | null; height: number | null; fps: number | null } | null;
  audio: { codec: string | null; channels: number | null; sampleRate: number | null } | null;
}

/** Lines shown at most, and files probed per job (info.py's MAX_FILES). */
export const SOURCES_LIMIT = 40;
const PROBE_BATCH = 64;
const PROBE_WAIT_MS = 1500;
/** A file that couldn't be read is tried again after this long (its drive may come back). */
const RETRY_FAILED_MS = 60_000;

const known = new Map<string, MediaFacts>();
const failedAt = new Map<string, number>();
let probing: Promise<void> | null = null;

export function factsOf(path: string): MediaFacts | undefined {
  return known.get(path);
}

/** For tests. */
export function forgetMediaFacts(): void {
  known.clear();
  failedAt.clear();
  probing = null;
}

/** The files the timeline uses, in the order they first appear. */
export function filesOf(timeline: HostTimeline): string[] {
  const seen = new Set<string>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.filePath && clip.kind !== "effect") seen.add(clip.filePath);
    }
  }
  return [...seen];
}

async function probe(paths: string[]): Promise<void> {
  const job = await runJob("media-info", `Read ${paths.length} file(s)' formats`, { paths });
  const result = (job?.result ?? {}) as { info?: Record<string, MediaFacts>; failed?: { path: string }[] };
  for (const [path, facts] of Object.entries(result.info ?? {})) {
    known.set(path, facts);
    failedAt.delete(path);
  }
  const now = Date.now();
  for (const path of paths) if (!known.has(path)) failedAt.set(path, now);
}

/** Starts reading the files not known yet (one job at a time) and waits at most `waitMs` for it. */
export async function learnFacts(paths: string[], waitMs = PROBE_WAIT_MS): Promise<void> {
  const now = Date.now();
  const wanted = paths.filter((p) => !known.has(p) && now - (failedAt.get(p) ?? -Infinity) > RETRY_FAILED_MS).slice(0, PROBE_BATCH);
  if (wanted.length && !probing) {
    probing = probe(wanted)
      .catch(() => {
        for (const path of wanted) failedAt.set(path, Date.now());
      })
      .finally(() => {
        probing = null;
      });
  }
  if (!probing) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([probing, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

function minutes(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One file as the snapshot shows it: `"A.mov": h264 3840x2160 23.976 fps · aac 2 ch 48 kHz · 12:03`. */
export function factsLine(path: string, facts: MediaFacts | undefined): string {
  if (!facts) return `"${fileName(path)}": (format not read yet)`;
  const parts: string[] = [];
  const { video, audio } = facts;
  if (video) {
    const size = video.width && video.height ? ` ${video.width}x${video.height}` : "";
    parts.push(`${video.codec ?? "video"}${size}${video.fps ? ` ${video.fps} fps` : ""}`);
  }
  if (audio) {
    const rate = audio.sampleRate ? ` ${audio.sampleRate % 1000 === 0 ? audio.sampleRate / 1000 : (audio.sampleRate / 1000).toFixed(1)} kHz` : "";
    parts.push(`${audio.codec ?? "audio"}${audio.channels ? ` ${audio.channels} ch` : ""}${rate}`);
  }
  if (!video && !audio) parts.push("no picture or sound streams");
  if (facts.duration) parts.push(minutes(facts.duration));
  return `"${fileName(path)}": ${parts.join(" · ")}`;
}

/** The [SOURCES] block for a timeline, or null when it uses no files. */
export function sourcesContext(timeline: HostTimeline): string | null {
  const files = filesOf(timeline);
  if (!files.length) return null;
  const shown = files.slice(0, SOURCES_LIMIT).map((path) => `  ${factsLine(path, known.get(path))}`);
  const more = files.length > SOURCES_LIMIT ? [`  (${files.length - SOURCES_LIMIT} more file(s))`] : [];
  return [`[SOURCES: ${files.length} file(s) on the timeline]`, ...shown, ...more].join("\n");
}
