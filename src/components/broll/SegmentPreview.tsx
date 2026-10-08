import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, MonitorPlay, Pause, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { allowPreview } from "../../lib/ipc";
import { connectedHost, openInSourceMonitor, NO_EDITOR } from "../../lib/library";
import { segmentsOf } from "../../lib/brollSelects";
import { clock } from "../../lib/agent/args";
import { useBrollStore } from "../../store/useBrollStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { RankedClip } from "../../types/broll";

/** What the app's web view plays: QuickTime-family files (H.264, HEVC, ProRes). Others go to the Source monitor. */
const PLAYABLE = new Set(["mov", "mp4", "m4v"]);

export const playableHere = (path: string) => PLAYABLE.has(path.split(".").pop()?.toLowerCase() ?? "");

const iconButton = "rounded p-1 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40";

/**
 * The Analyze tab's segment preview (PLAN.md, "Phase 10"): plays one segment of a clip in a loop, read
 * straight from disk (broll_preview.rs allows just that file). Space plays or pauses, ←/→ go to the
 * clip's other segments, R replays, Esc closes. Formats the web view can't play offer the editor's
 * Source monitor instead.
 */
export function SegmentPreview({ clip, index }: { clip: RankedClip; index: number }) {
  const setPreview = useBrollStore((s) => s.setPreview);
  const segments = segmentsOf(clip);
  const segment = segments[Math.min(index, segments.length - 1)];
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(playableHere(clip.path) ? null : "This format can't play here.");
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  useNleStateStore((s) => s.hosts);
  const host = connectedHost();

  // Allow and load this clip (once per clip, not per segment).
  useEffect(() => {
    let live = true;
    setSrc(null);
    setNotice(null);
    if (!playableHere(clip.path)) {
      setFailed("This format can't play here.");
      return;
    }
    setFailed(null);
    allowPreview(clip.path)
      .then(() => live && setSrc(convertFileSrc(clip.path)))
      .catch((error: unknown) => live && setFailed(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, [clip.path]);

  // A new segment starts from its In.
  useEffect(() => {
    const v = video.current;
    if (!v || !src || v.readyState < 1) return;
    v.currentTime = segment.start;
    void v.play().catch(() => undefined);
  }, [segment.start, segment.end, src]);

  useEffect(() => box.current?.focus(), [clip.path]);

  const replay = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = segment.start;
    void v.play().catch(() => undefined);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < segments.length) setPreview({ path: clip.path, index: next });
  };
  const toSource = async () => {
    if (!host) return setNotice({ text: NO_EDITOR, failed: true });
    try {
      setNotice({ text: await openInSourceMonitor(host, { path: clip.path, filename: clip.filename, start: segment.start, end: segment.end }), failed: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), failed: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button") && (event.key === " " || event.key === "Enter")) return;
    if (event.key === " ") toggle();
    else if (event.key === "ArrowLeft") go(-1);
    else if (event.key === "ArrowRight") go(1);
    else if (event.key.toLowerCase() === "r") replay();
    else if (event.key === "Escape") setPreview(null);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={box}
      role="region"
      aria-label={`Preview of ${clip.filename}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-1.5 rounded-md border border-border bg-surface p-2 outline-none focus-visible:ring-1 focus-visible:ring-athletic-blue-light"
    >
      <div className="relative aspect-video overflow-hidden rounded bg-black">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-cool-grey">
            <p>{failed}</p>
            <button type="button" onClick={() => void toSource()} disabled={!host} title={host ? undefined : NO_EDITOR} className="flex items-center gap-1 rounded-md bg-athletic-blue px-2.5 py-1 text-white hover:brightness-125 disabled:opacity-40">
              <MonitorPlay size={13} aria-hidden="true" />
              Open in Source monitor
            </button>
          </div>
        ) : src ? (
          <video
            ref={video}
            src={src}
            muted={muted}
            playsInline
            preload="metadata"
            aria-label={`${clip.filename}, ${clock(segment.start)} to ${clock(segment.end)}`}
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = segment.start;
              void e.currentTarget.play().catch(() => undefined);
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.currentTime >= segment.end || v.currentTime < segment.start - 0.25) v.currentTime = segment.start;
            }}
            onEnded={replay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setFailed("This file can't play here (its codec isn't supported).")}
          />
        ) : (
          <p className="flex h-full items-center justify-center text-[11px] text-cool-grey">Loading…</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className={iconButton} onClick={toggle} disabled={!src || !!failed} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <button type="button" className={iconButton} onClick={replay} disabled={!src || !!failed} aria-label="Replay" title="Replay from the segment's In (R)">
          <RotateCcw size={14} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} onClick={() => setMuted(!muted)} disabled={!src || !!failed} aria-label={muted ? "Sound on" : "Sound off"} aria-pressed={!muted} title={muted ? "Sound on" : "Sound off"}>
          {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-white" title={clip.path}>
          {clip.filename}
          <span className="font-mono text-cool-grey">
            {" "}
            · {clock(segment.start)}–{clock(segment.end)}
            {segments.length > 1 ? ` · ${index + 1}/${segments.length}` : ""}
          </span>
        </span>
        {segments.length > 1 ? (
          <>
            <button type="button" className={iconButton} onClick={() => go(-1)} disabled={index === 0} aria-label="Previous segment" title="Previous segment (←)">
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <button type="button" className={iconButton} onClick={() => go(1)} disabled={index >= segments.length - 1} aria-label="Next segment" title="Next segment (→)">
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </>
        ) : null}
        {!failed ? (
          <button type="button" className={iconButton} onClick={() => void toSource()} disabled={!host} aria-label="Open in Source monitor" title={host ? "Open this segment in the editor's Source monitor, In and Out marked" : NO_EDITOR}>
            <MonitorPlay size={14} aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className={iconButton} onClick={() => setPreview(null)} aria-label="Close preview" title="Close (Esc)">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {notice ? (
        <p role={notice.failed ? "alert" : "status"} className={`text-[11px] ${notice.failed ? "text-loss" : "text-profit"}`}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
