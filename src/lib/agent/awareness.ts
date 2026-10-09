/**
 * Short lines the snapshot gains in Phase 13a, so the agent knows what's ready before it calls a tool:
 * which files heard on the timeline have a transcript (and who speaks in them), and what find_broll
 * searches. The files' formats are mediaInfo.ts's [SOURCES].
 */
import { useConnectionStore } from "../../store/useConnectionStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";
import { invoke } from "@tauri-apps/api/core";

/** Files listed by name at most; the rest are counted. */
export const TRANSCRIPTS_LIMIT = 12;

/** Speaker ids and the transcriber's labels of each transcribed file; a file with none is re-read each time. */
const transcribed = new Map<string, { speakers: string[]; labels: Record<string, string> }>();

/** After transcribe_clips (its speakers may have changed), or for tests. */
export function forgetTranscriptStatus(paths?: string[]): void {
  if (!paths) transcribed.clear();
  else paths.forEach((p) => transcribed.delete(p));
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** The files whose sound is heard: on an audio track that's on, in a clip that's on. */
export function heardFiles(timeline: HostTimeline): string[] {
  const seen = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.type !== "audio" || track.enabled === false) continue;
    for (const clip of track.clips) if (clip.filePath && clip.enabled && clip.kind !== "effect") seen.add(clip.filePath);
  }
  return [...seen];
}

async function statusOf(path: string): Promise<{ speakers: string[]; labels: Record<string, string> } | null> {
  const cached = transcribed.get(path);
  if (cached) return cached;
  // transcriptTools.ts's readTranscript, called directly: that module forgets this cache after transcribing.
  const data = await invoke<TranscriptData | null>("read_transcript", { mediaPath: path }).catch(() => null);
  if (!data || !data.segments.length) return null;
  const status = { speakers: data.speakers.filter((s) => !data.excludedSpeakers.includes(s)), labels: data.speakerLabels ?? {} };
  transcribed.set(path, status);
  return status;
}

/** `[TRANSCRIPTS: 2 of 3 heard file(s)] "A.mov" (Dana, interviewer; Sam) · "B.mov" — none yet: "C.wav"`. */
export async function transcriptsContext(host: NleHost, timeline: HostTimeline): Promise<string | null> {
  const files = heardFiles(timeline);
  if (!files.length) return null;
  const saved = useConnectionStore.getState().connections[host].speakerInfo;
  const statuses = await Promise.all(files.map(statusOf));
  const done: string[] = [];
  const missing: string[] = [];
  files.forEach((path, i) => {
    const status = statuses[i];
    if (!status) {
      missing.push(`"${fileName(path)}"`);
      return;
    }
    const names = status.speakers.map((id) => {
      const info = saved[path]?.[id];
      const name = info?.name || status.labels[id] || id;
      return info?.role && info.role !== "other" ? `${name}, ${info.role}` : name;
    });
    done.push(`"${fileName(path)}"${names.length > 1 ? ` (${names.join("; ")})` : ""}`);
  });
  const list = (items: string[]) =>
    items.length > TRANSCRIPTS_LIMIT ? `${items.slice(0, TRANSCRIPTS_LIMIT).join(" · ")} · and ${items.length - TRANSCRIPTS_LIMIT} more` : items.join(" · ");
  const parts = [done.length ? list(done) : null, missing.length ? `none yet: ${list(missing)} (transcribe_clips makes them)` : null].filter(Boolean);
  return `[TRANSCRIPTS: ${done.length} of ${files.length} heard file(s)] ${parts.join(" — ")}`;
}

/** What find_broll searches when no folders are given: the Library's ticked folders, else everything. */
export function libraryContext(): string {
  const scopes = useLibraryStore.getState().scopes;
  if (!scopes.length) return "[B-ROLL: find_broll searches the whole Spyglass archive]";
  const names = scopes.slice(0, 6).map((p) => `"${fileName(p.replace(/[\\/]+$/, ""))}"`);
  const more = scopes.length > 6 ? ` and ${scopes.length - 6} more` : "";
  return `[B-ROLL: find_broll searches the folder(s) ticked in the Library: ${names.join(", ")}${more}]`;
}
