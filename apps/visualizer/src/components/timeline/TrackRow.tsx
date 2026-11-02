/**
 * One lane of the OTIO dock (visualizer-spec.md §4.2 B): each op drawn as its kind of change.
 * - Inserts and overwrites have an emerald border, a flash while proposed, and a lock once committed.
 * - Trims and splits get amber brackets with the frame delta, and a split a razor line.
 * - A delete is red cross-hatched; ripple is marked.
 * - A gap shows chevrons with its length in frames.
 * - A duck or gain change draws its dB envelope over the clip, and its waveform when one was streamed.
 * Every clip carries a pill naming its agent and op; hovering it lights the task in the DAG.
 */
import { memo, type ReactNode } from "react";
import { duckEnvelopePath, DEFAULT_DUCK_DB, RAMP_SECONDS, trimDeltaFrames } from "../../lib/timeline/viewModel";
import { frameDelta } from "../../lib/timecode/rationalTime";
import type { ClipDiffViewModel, OtioTrackViewModel } from "../../types/timeline";

export const ROW_HEIGHT = 36;

const STAGE_LABEL: Record<string, string> = {
  PROPOSED: "PROPOSED",
  VALIDATED: "VALIDATED",
  COMMITTED: "✓ COMMITTED",
  ROLLED_BACK: "ROLLED BACK",
};

function Waveform({ peaks, width, height }: { peaks: number[]; width: number; height: number }) {
  const pairs = Math.floor(peaks.length / 2);
  if (pairs === 0) return null;
  const mid = height / 2;
  let d = "";
  for (let i = 0; i < pairs; i++) {
    const x = (i / pairs) * width;
    d += `M ${x.toFixed(1)} ${(mid - peaks[2 * i + 1] * mid).toFixed(1)} L ${x.toFixed(1)} ${(mid - peaks[2 * i] * mid).toFixed(1)} `;
  }
  return <path d={d} stroke="#99928a" strokeWidth={1} opacity={0.6} data-testid="waveform" />;
}

function Clip({ clip, pxPerSec, peaks, onHover, fresh }: { clip: ClipDiffViewModel; pxPerSec: number; peaks: number[] | null; onHover: (task: string | null) => void; fresh: boolean }) {
  const { op } = clip;
  const height = ROW_HEIGHT - 6;
  const kind = op.op_type;
  const committed = clip.stage === "COMMITTED";
  const base = "absolute top-[3px] overflow-hidden rounded-sm border text-[10px] leading-tight";
  let border = "#4a90d9";
  let background = "#002244";
  let overlay: ReactNode = null;
  if (kind === "INSERT_CLIP" || kind === "OVERWRITE_CLIP") {
    border = "#00c853";
    background = "#0f2a1c";
  } else if (kind === "TRIM_CLIP" || kind === "SPLIT_CLIP") {
    border = "#ffb300";
    background = "#2a2310";
    const delta = trimDeltaFrames(op);
    overlay = (
      <>
        <span className="absolute left-0 top-0 h-full w-1.5 border-y-2 border-l-2 border-warning" aria-hidden="true" />
        <span className="absolute right-0 top-0 h-full w-1.5 border-y-2 border-r-2 border-warning" aria-hidden="true" />
        {kind === "SPLIT_CLIP" && <span className="absolute left-0 top-0 h-full w-0.5 bg-loss" data-testid="razor" aria-hidden="true" />}
        {delta !== null && delta !== 0 && <span className="absolute bottom-0 right-2 font-mono text-warning">{frameDelta(delta)}</span>}
      </>
    );
  } else if (kind === "DELETE_CLIP") {
    border = "#ff5252";
    background = "repeating-linear-gradient(45deg, #3a1414 0 4px, #ff525244 4px 6px)";
    overlay = op.ripple ? <span className="absolute bottom-0 right-1 font-mono text-loss">⟵ ripple</span> : null;
  } else if (kind === "INSERT_GAP") {
    border = "#72808a";
    background = "#161b22";
    overlay = <span className="absolute inset-0 flex items-center justify-center font-mono text-cool-grey">» » » {op.timeline_range.duration.value}f</span>;
  } else if (kind === "DUCK_REGION" || kind === "SET_AUDIO_GAIN") {
    border = "#14b8a6";
    background = "#0e2523";
    const rampPx = RAMP_SECONDS * pxPerSec;
    overlay = (
      <svg className="absolute inset-0" width={clip.width} height={height} aria-hidden="true">
        {peaks && <Waveform peaks={peaks} width={clip.width} height={height} />}
        <path
          d={duckEnvelopePath(clip.width, height, rampPx, op.gain_db ?? DEFAULT_DUCK_DB, kind === "DUCK_REGION")}
          fill="none"
          stroke="#ffb300"
          strokeWidth={1.5}
          data-testid="gain-envelope"
        />
        <text x={Math.min(clip.width - 4, rampPx + 4)} y={height - 4} fill="#ffb300" fontSize="9" fontFamily="monospace">
          {kind === "DUCK_REGION" ? "DUCK " : "GAIN "}
          {op.gain_db ?? DEFAULT_DUCK_DB} dB
        </text>
      </svg>
    );
  } else if (kind === "APPLY_TRANSITION") {
    border = "#a855f7";
    background = "linear-gradient(90deg, #a855f733, transparent)";
  }
  if (clip.stage === "ROLLED_BACK") border = "#ff5252";
  return (
    <div
      className={`${base} ${fresh && clip.stage === "PROPOSED" ? "clip-enter" : ""}`}
      style={{ left: clip.x, width: clip.width, height, borderColor: border, background, opacity: clip.stage === "ROLLED_BACK" ? 0.5 : 1 }}
      data-op-type={kind}
      data-stage={clip.stage}
      title={`${kind} ${op.source_name ?? op.clip_id ?? ""} (${clip.delta_id} · ${clip.stage})`}
      onMouseEnter={() => onHover(clip.task_id)}
      onMouseLeave={() => onHover(null)}
    >
      {overlay}
      <span className="relative flex items-center gap-1 px-1 pt-0.5">
        <span className="truncate text-[#e6edf3]">
          {kind.replace("_CLIP", "").replace("_", " ")}
          {op.source_name ? `: ${op.source_name}` : ""}
        </span>
      </span>
      <span className="relative flex items-center gap-1 px-1">
        <span className="rounded bg-canvas/80 px-1 font-mono text-cool-grey" data-testid="attribution">
          [{clip.agent_short} · {op.op_id}]
        </span>
        {committed && (
          <span className="rounded bg-profit px-1 font-mono font-semibold text-canvas" data-testid="lock">
            🔒
          </span>
        )}
      </span>
      <span className="sr-only">{STAGE_LABEL[clip.stage]}</span>
    </div>
  );
}

export interface TrackRowProps {
  track: OtioTrackViewModel;
  pxPerSec: number;
  width: number;
  waveforms: Record<number, number[]>;
  /** The delta's seq → its waveform's seq (the commit). */
  seqOfDelta: Record<string, number>;
  freshDeltaId: string | null;
  onHover: (task: string | null) => void;
}

export const TrackRow = memo(function TrackRow({ track, pxPerSec, width, waveforms, seqOfDelta, freshDeltaId, onHover }: TrackRowProps) {
  return (
    <div className="flex border-b border-border" style={{ height: ROW_HEIGHT }} role="row" aria-label={`${track.label} ${track.title}`}>
      <div className="sticky left-0 z-10 flex w-24 shrink-0 items-center gap-1 border-r border-border bg-surface px-2 font-mono text-[11px]" role="rowheader">
        <span className="font-semibold text-[#e6edf3]">{track.label}</span>
        <span className="truncate text-cool-grey">({track.title})</span>
      </div>
      <div className="relative" style={{ width }} role="gridcell">
        {track.clips.map((clip) => (
          <Clip
            key={clip.key}
            clip={clip}
            pxPerSec={pxPerSec}
            peaks={track.kind === "Audio" ? (waveforms[seqOfDelta[clip.delta_id]] ?? null) : null}
            onHover={onHover}
            fresh={clip.delta_id === freshDeltaId}
          />
        ))}
      </div>
    </div>
  );
});
