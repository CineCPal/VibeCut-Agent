/**
 * Timeline positions in the agent's replies (Phase 8e): `[1:23.4](t:83.4)` links the prompt asks for, and
 * SMPTE timecodes ("01:00:12:10", drop-frame "01:00:12;10") read against the last snapshot's timeline.
 */

/** The timeline a reply's positions refer to: the one the last snapshot described. */
export interface TimelineInfo {
  host: "premiere" | "resolve";
  timeline: string;
  fps: number;
  startTimecode: string;
}

/** Matches a whole SMPTE timecode; `;` (or `.`) before the frames marks drop-frame. */
export const SMPTE_PATTERN = /\b(\d{1,2}):([0-5]\d):([0-5]\d)([:;.])(\d{2})\b/g;

/** The seconds in a `t:` link ("t:83.4"), or null if it isn't one. */
export function secondsFromLink(href: string | undefined | null): number | null {
  const match = /^t:(\d+(?:\.\d+)?)$/.exec(href ?? "");
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function isDropRate(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
}

/** Frames since 00:00:00:00 for a timecode at `fps`, or null when it isn't valid there. */
export function timecodeToFrames(timecode: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{2})$/.exec(timecode.trim());
  if (!match || !(fps > 0)) return null;
  const [h, m, s, f] = [match[1], match[2], match[3], match[5]].map(Number);
  const nominal = Math.round(fps);
  if (m > 59 || s > 59 || f >= nominal) return null;
  const frames = ((h * 60 + m) * 60 + s) * nominal + f;
  if (match[4] === ":" || !isDropRate(fps)) return frames;
  // Drop-frame: two frame numbers (four at 59.94) are skipped each minute, except every tenth.
  const dropped = nominal === 60 ? 4 : 2;
  const minutes = h * 60 + m;
  if (s === 0 && f < dropped && minutes % 10 !== 0) return null;
  return frames - dropped * (minutes - Math.floor(minutes / 10));
}

/** Seconds from the timeline's start for a SMPTE timecode, or null when it can't be placed on it. */
export function timecodeToSeconds(timecode: string, info: Pick<TimelineInfo, "fps" | "startTimecode">): number | null {
  const at = timecodeToFrames(timecode, info.fps);
  if (at === null) return null;
  const start = timecodeToFrames(info.startTimecode, info.fps) ?? 0;
  if (at < start) return null;
  return (at - start) / info.fps;
}

/** "1:23.4" (or "1:02:03.4" past an hour): how a chip labels a position. */
export function positionLabel(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const s = (tenths % 600) / 10;
  const totalMinutes = Math.floor(tenths / 600);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const secs = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${secs}` : `${m}:${secs}`;
}
