/**
 * @-mentions (Phase 11c): the user points at a timeline, clip, marker, media, speaker or Library shot
 * while typing, and the model is told exactly which one, with its id and place, in a `[MENTIONED]` block
 * after the snapshot, so it doesn't have to search for it.
 *
 * Candidates come from what the app already holds: the editor's timelines, the timeline the last
 * snapshot read (read once when the list opens if there's none), the project's pool, the speakers named
 * this connection, and the Library's results and pool. Nothing new is searched.
 */
import { nleCall } from "../ipc";
import { clock } from "./args";
import { aliasOf } from "./projectTools";
import { draftOf } from "./draft";
import { lastTimelineView, rememberTimelineView } from "./context";
import { draftAsTimeline } from "../../vibecut/lib/connect/hostDraft";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import type { ChatMention, MentionKind } from "../../types/agent";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";

export const MENTION_GROUPS: { kind: MentionKind; label: string }[] = [
  { kind: "timeline", label: "Timelines" },
  { kind: "clip", label: "Clips" },
  { kind: "marker", label: "Markers" },
  { kind: "media", label: "Media" },
  { kind: "speaker", label: "Speakers" },
  { kind: "shot", label: "Library" },
];

const PER_GROUP = 8;

const baseName = (path: string) => path.split("/").pop() ?? path;
const span = (start: number, end: number) => `${clock(start)}–${clock(end)}`;

/** The text after an @ just before the caret, and where its @ is, or null when the caret isn't in one. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[2], start: caret - match[2].length - 1 } : null;
}

/** The timeline mentions read clips and markers from: the open draft, else the last one read. */
export function mentionTimeline(): { host: NleHost; view: HostTimeline } | null {
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  if (!host) return null;
  const draft = draftOf(host);
  if (draft) return { host, view: draftAsTimeline(draft, nle.hosts[host].project ?? "") };
  const timeline = nle.hosts[host].timeline;
  const view = timeline ? lastTimelineView(host, timeline) : null;
  return view ? { host, view } : null;
}

/** Reads the open timeline for the list when no snapshot has yet (one call). True when it was read. */
export async function loadMentionTimeline(): Promise<boolean> {
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  const timeline = host ? nle.hosts[host].timeline : null;
  if (!host || !timeline || mentionTimeline()) return false;
  try {
    rememberTimelineView(host, timeline, await nleCall<HostTimeline>(host, "read_timeline", { timeline }));
    return true;
  } catch {
    return false;
  }
}

/** Everything that can be mentioned now, in MENTION_GROUPS' order. */
export function allMentions(): ChatMention[] {
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  const out: ChatMention[] = [];
  if (host) {
    for (const name of nle.hosts[host].timelines) out.push({ kind: "timeline", label: name, ref: name });
    const read = mentionTimeline();
    if (read) {
      for (const track of read.view.tracks) {
        const tag = `${track.type === "audio" ? "A" : track.type === "video" ? "V" : "S"}${track.index}`;
        for (const clip of track.clips) {
          if (clip.kind === "effect") continue;
          out.push({ kind: "clip", label: clip.name, ref: clip.id, detail: `${tag} ${span(clip.start, clip.end)}` });
        }
      }
      for (const marker of read.view.markers) {
        out.push({ kind: "marker", label: marker.name || `Marker at ${clock(marker.time)}`, ref: marker.id, detail: `at ${clock(marker.time)}` });
      }
    }
    const connection = useConnectionStore.getState().connections[host];
    for (const clip of connection.pool?.clips ?? []) {
      out.push({ kind: "media", label: clip.name, ref: aliasOf(host, clip.id), detail: [clip.bin, clip.type].filter(Boolean).join(" · ") });
    }
    for (const [path, speakers] of Object.entries(connection.speakerInfo)) {
      for (const [id, info] of Object.entries(speakers)) {
        out.push({ kind: "speaker", label: info.name || id, ref: `${id} in ${baseName(path)}`, detail: [info.role, path].filter(Boolean).join(" · ") });
      }
    }
  }
  const library = useLibraryStore.getState();
  const seen = new Set<string>();
  for (const shot of [...library.pool, ...library.results]) {
    if (seen.has(shot.key)) continue;
    seen.add(shot.key);
    out.push({ kind: "shot", label: shot.caption ? `${shot.filename} (${shot.caption.slice(0, 40)})` : shot.filename, ref: shot.path, detail: span(shot.start, shot.end) });
  }
  return out;
}

/** The candidates for `query` (case-insensitive; names starting with it first), at most PER_GROUP a group. */
export function matchingMentions(all: ChatMention[], query: string): ChatMention[] {
  const q = query.toLowerCase();
  const out: ChatMention[] = [];
  for (const { kind } of MENTION_GROUPS) {
    const group = all.filter((m) => m.kind === kind && m.label.toLowerCase().includes(q));
    group.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
    out.push(...group.slice(0, PER_GROUP));
  }
  return out;
}

/** The mentions still in the text (one per label), so deleting an @Name drops it. */
export function keptMentions(text: string, mentions: ChatMention[]): ChatMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.kind}:${m.label}`;
    if (seen.has(key) || !text.includes(`@${m.label}`)) return false;
    seen.add(key);
    return true;
  });
}

const KIND_WORD: Record<MentionKind, string> = {
  timeline: "timeline",
  clip: "clip id",
  marker: "marker id",
  media: "pool item",
  speaker: "speaker",
  shot: "Library shot, file",
};

/** What the model is told after the snapshot: one exact line per mention. Empty with none. */
export function mentionBlock(mentions: ChatMention[]): string {
  if (!mentions.length) return "";
  const lines = mentions.map((m) => `- @${m.label} = ${KIND_WORD[m.kind]} ${JSON.stringify(m.ref)}${m.detail ? ` (${m.detail})` : ""}`);
  return `[MENTIONED: what the user pointed at with @ in this message]\n${lines.join("\n")}`;
}
