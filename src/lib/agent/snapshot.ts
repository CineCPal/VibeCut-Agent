import type { NleHost } from "../../types/nle";
import type { HostMarker, HostTimeline } from "../../types/timeline";
import { clock } from "./args";
import { editLogContext } from "./edits";

/** Abridges the snapshot past this many clips, like VibeCut's. */
export const CONTEXT_CLIP_LIMIT = 120;

export const markerLine = (m: HostMarker): string =>
  `${m.id} ${clock(m.time)} ${m.color} "${m.name}"${m.note ? ` (${m.note})` : ""}`;

/** Clips linked to each other share a group id: the smallest id among each connected set. */
export function linkGroups(timeline: HostTimeline): Map<string, string> {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      for (const other of clip.linkedIds ?? []) {
        link(clip.id, other);
        link(other, clip.id);
      }
    }
  }
  const groups = new Map<string, string>();
  for (const start of neighbours.keys()) {
    if (groups.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const id = queue.shift()!;
      members.push(id);
      for (const next of neighbours.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const group = [...members].sort()[0];
    members.forEach((id) => groups.set(id, group));
  }
  return groups;
}

/** The tracks, clips and markers lines of a timeline, ported from VibeCut's `timelineLines`. */
export function timelineLines(snapshot: HostTimeline): string[] {
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  // Linked clips share a short tag ("link L1"), numbered in timeline order.
  const groups = linkGroups(snapshot);
  const tags = new Map<string, string>();
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      const group = groups.get(clip.id);
      if (group && !tags.has(group)) tags.set(group, `L${tags.size + 1}`);
    }
  }
  for (const track of snapshot.tracks) {
    total += track.clips.length;
    const flags = [track.enabled === false ? "off" : null, track.locked ? "locked" : null].filter(Boolean);
    const letter = track.type === "video" ? "V" : track.type === "audio" ? "A" : "S";
    const label = `${letter}${track.index}${track.name ? ` "${track.name}"` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    const clips: string[] = [];
    for (const clip of track.clips) {
      if (shown >= CONTEXT_CLIP_LIMIT) break;
      shown++;
      const extras = [
        clip.kind === "effect" ? "transition/generator" : null,
        clip.sourceIn !== undefined ? `from ${clock(clip.sourceIn)}` : null,
        clip.speed !== undefined && clip.speed !== 1 ? `speed ${Math.round(clip.speed * 100)}%` : null,
        clip.volumeDb !== undefined && clip.volumeDb !== 0 ? `${clip.volumeDb} dB` : null,
        clip.fusion ? "Fusion" : null,
        clip.fadeIn ? `fade in ${clock(clip.fadeIn)}` : null,
        clip.fadeOut ? `fade out ${clock(clip.fadeOut)}` : null,
        clip.enabled ? null : "off",
        groups.has(clip.id) ? `link ${tags.get(groups.get(clip.id)!)}` : null,
      ].filter(Boolean);
      clips.push(`  ${clip.id} "${clip.name}" ${clock(clip.start)}–${clock(clip.end)}${extras.length ? ` (${extras.join(", ")})` : ""}`);
    }
    lines.push(`${label}: ${track.clips.length} clip(s)`, ...clips);
  }
  if (shown < total) lines.push(`(abridged: ${total - shown} more clip(s); call list_timeline_clips)`);
  lines.push(snapshot.markers.length ? `Markers:\n${snapshot.markers.map((m) => `  ${markerLine(m)}`).join("\n")}` : "Markers: none");
  return lines;
}

const HOST_NOUN: Record<NleHost, string> = { premiere: "Premiere sequence", resolve: "Resolve timeline" };

/** The context put ahead of each user message: the open timeline now, or why there is none. */
export function snapshotHeader(host: NleHost | null, timeline: HostTimeline | null, problem?: string): string {
  if (!host) return "[No editor connected: Premiere Pro and DaVinci Resolve are both closed or unreachable.]";
  if (!timeline) return `[${HOST_NOUN[host]}: ${problem ?? "none open (create_timeline makes one)"}]`;
  const head = `[${HOST_NOUN[host]} "${timeline.timeline}" in project "${timeline.project}", ${timeline.fps} fps, ${clock(timeline.duration)} long, starts at ${timeline.startTimecode}]`;
  const edits = editLogContext();
  return [head, ...timelineLines(timeline), ...(edits ? [edits] : [])].join("\n");
}
