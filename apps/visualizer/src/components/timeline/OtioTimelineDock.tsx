/**
 * Pane B, the OTIO live preview (visualizer-spec.md §4.2 B): V2, V1, A1 and A2 (and any other track a
 * delta names) with every op of every delta at its exact RationalTime, its latest stage, and who made it.
 * The header shows the playhead's timecode at the timeline's rate, and the latest delta and its stage. When
 * the app started the gateway, "Move playhead" moves the editor's playhead on that delta's timeline to the
 * preview's (lib/control.ts).
 *
 * Dragging the ruler scrubs: with "Scrub audio" on (the default, remembered per browser), the sound under
 * the playhead comes from the gateway (lib/audio/scrubPlayer.ts). An audio lane wins over picture, and the
 * newest delta wins on a lane. There's no gateway with the mock source, so no toggle there.
 */
import type { SupportedRate } from "@vibecut/contracts";
import { useCallback, useMemo, useState } from "react";
import { useAppControl } from "../../lib/control";
import { buildTracks, clipAt, timelineSeconds } from "../../lib/timeline/viewModel";
import { rationalTime, toSmpte } from "../../lib/timecode/rationalTime";
import { selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import { DockToggle } from "../workspace/DockToggle";
import { secondsToFrame, TimecodeRuler } from "./TimecodeRuler";
import { TrackRow } from "./TrackRow";

export const ZOOMS = [5, 10, 20, 40, 80, 160];

const STAGE_COLOR: Record<string, string> = {
  PROPOSED: "#4a90d9",
  VALIDATED: "#ffb300",
  COMMITTED: "#00c853",
  ROLLED_BACK: "#ff5252",
};

export function OtioTimelineDock({ collapsible = true }: { collapsible?: boolean } = {}) {
  const view = useVisualizerStore(selectView);
  const collapsed = useVisualizerStore((s) => collapsible && s.collapsedDocks.otio);
  const waveforms = useVisualizerStore((s) => s.waveforms);
  const hoverTask = useVisualizerStore((s) => s.hoverTask);
  const scrubber = useVisualizerStore((s) => s.scrubber);
  const scrubAudio = useVisualizerStore((s) => s.scrubAudio);
  const scrubNotice = useVisualizerStore((s) => s.scrubNotice);
  const toggleScrubAudio = useVisualizerStore((s) => s.toggleScrubAudio);
  const setScrubNotice = useVisualizerStore((s) => s.setScrubNotice);
  const [zoom, setZoom] = useState(2);
  const [playheadSec, setPlayheadSec] = useState(0);
  const control = useAppControl();
  const pxPerSec = ZOOMS[zoom];
  const tracks = useMemo(() => buildTracks(view.mutations, pxPerSec), [view.mutations, pxPerSec]);
  const seconds = useMemo(() => timelineSeconds(view.mutations), [view.mutations]);
  const latest = useMemo(
    () => Object.values(view.mutations).sort((a, b) => b.seq_id - a.seq_id)[0] ?? null,
    [view.mutations],
  );
  const rate: SupportedRate = latest?.timeline_fps ?? 24;
  const width = Math.max(320, Math.ceil((seconds + 10) * pxPerSec));
  const playhead = toSmpte(rationalTime(secondsToFrame(playheadSec, rate), rate));
  const traceId = view.trace_id;
  const seek = useCallback(
    (seconds: number) => {
      setPlayheadSec(seconds);
      if (!scrubAudio || !scrubber || !traceId) return;
      const clip = clipAt(tracks, seconds);
      if (!clip) {
        setScrubNotice("No sound under the playhead");
        return;
      }
      scrubber.request({
        traceId,
        deltaId: clip.delta_id,
        opId: clip.op.op_id,
        timelineSeconds: seconds,
        seq: clip.first_seq_id,
        channel: clip.op_index,
      });
    },
    [scrubAudio, scrubber, traceId, tracks, setScrubNotice],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="OTIO live preview">
      <div className={`flex flex-wrap items-center gap-3 bg-surface px-3 py-1 font-mono text-[11px] ${collapsed ? "" : "border-b border-border"}`}>
        <DockToggle dock="otio" title="OTIO Live Preview" controls="otio-tracks" hotkey="T" collapsible={collapsible} />
        <span className="text-cool-grey">
          TC: <span className="text-[#e6edf3]" data-testid="playhead-tc">{playhead}</span> ({rate} fps)
        </span>
        {latest ? (
          <span className="text-cool-grey">
            Delta: <span className="text-[#e6edf3]">{latest.delta_id}</span>{" "}
            <span className="rounded border px-1" style={{ color: STAGE_COLOR[latest.mutation_stage], borderColor: STAGE_COLOR[latest.mutation_stage] }} data-testid="delta-stage">
              {latest.mutation_stage}
              {latest.mutation_stage === "COMMITTED" ? " ✓" : ""}
            </span>{" "}
            {latest.target_host === "resolve" ? "Resolve" : "Premiere"} · {latest.target_timeline}
          </span>
        ) : (
          <span className="text-cool-grey">No delta yet</span>
        )}
        {latest && control.available && (
          <button
            type="button"
            className="rounded border border-border px-1.5 font-sans text-cool-grey hover:border-cool-grey hover:text-white"
            title={`Move the playhead of ${latest.target_timeline} in ${latest.target_host === "resolve" ? "Resolve" : "Premiere"} to ${playhead}`}
            onClick={() =>
              control.send(
                "SET_NLE_PLAYHEAD",
                { host: latest.target_host, timeline: latest.target_timeline, seconds: playheadSec },
                `Playhead sent: ${playhead}`,
              )
            }
          >
            Move playhead
          </button>
        )}
        {control.notice && <span className="font-sans text-cool-grey" role="status">{control.notice}</span>}
        {scrubber && (
          <button
            type="button"
            aria-pressed={scrubAudio}
            className={`rounded border px-1.5 font-sans ${scrubAudio ? "border-athletic-blue-light text-[#e6edf3]" : "border-border text-cool-grey"} hover:text-white`}
            title={scrubAudio ? "Dragging the ruler plays the sound under the playhead" : "Scrub audio is off"}
            onClick={toggleScrubAudio}
          >
            {scrubAudio ? "🔊" : "🔇"} Scrub audio
          </button>
        )}
        {scrubber && scrubAudio && scrubNotice && (
          <span className="font-sans text-cool-grey" role="status" data-testid="scrub-notice">
            {scrubNotice}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded border border-border px-1.5 text-cool-grey hover:text-white disabled:opacity-40" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} aria-label="Zoom out the timeline">
            −
          </button>
          <span className="w-14 text-center text-cool-grey">{pxPerSec}px/s</span>
          <button type="button" className="rounded border border-border px-1.5 text-cool-grey hover:text-white disabled:opacity-40" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1} aria-label="Zoom in the timeline">
            +
          </button>
        </span>
      </div>
      <div id="otio-tracks" className="min-h-0 flex-1 overflow-auto" role="grid" aria-label="Timeline tracks" hidden={collapsed}>
        <div style={{ width: width + 96 }}>
          <div className="flex">
            <div className="sticky left-0 z-10 w-24 shrink-0 border-b border-r border-border bg-surface" />
            <TimecodeRuler seconds={seconds + 10} pxPerSec={pxPerSec} rate={rate} playheadSec={playheadSec} onSeek={seek} />
          </div>
          {tracks.map((track) => (
            <TrackRow
              key={track.label}
              track={track}
              pxPerSec={pxPerSec}
              width={width}
              waveforms={waveforms}
              freshDeltaId={latest?.mutation_stage === "PROPOSED" ? latest.delta_id : null}
              onHover={hoverTask}
            />
          ))}
        </div>
      </div>
      {latest && !collapsed && (
        <p className="truncate border-t border-border bg-surface px-3 py-0.5 text-[11px] text-warm-grey" title={latest.narrative_rationale}>
          {latest.narrative_rationale}
        </p>
      )}
    </section>
  );
}
