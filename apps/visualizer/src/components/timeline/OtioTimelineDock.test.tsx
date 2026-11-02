import type { DeltaOpSummary, SupportedRate, TelemetryPayload } from "@vibecut/contracts";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTracks, duckEnvelopePath, timelineSeconds, trimDeltaFrames } from "../../lib/timeline/viewModel";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { env } from "../../test/envelopes";
import { OtioTimelineDock } from "./OtioTimelineDock";
import type { MutationRecord } from "../../types/timeline";

const rt = (value: number, rate: SupportedRate) => ({ OTIO_SCHEMA: "RationalTime.1" as const, value, rate });
const tr = (start: number, duration: number, rate: SupportedRate) => ({
  OTIO_SCHEMA: "TimeRange.1" as const,
  start_time: rt(start, rate),
  duration: rt(duration, rate),
});

function op(id: string, type: DeltaOpSummary["op_type"], kind: "Video" | "Audio", index: number, start: number, duration: number, rate: SupportedRate, extra: Partial<DeltaOpSummary> = {}): DeltaOpSummary {
  return {
    op_id: id,
    op_type: type,
    track_kind: kind,
    track_index: index,
    clip_id: null,
    source_name: `${id}.mov`,
    target_url: null,
    source_range: null,
    timeline_range: tr(start, duration, rate),
    ripple: false,
    ...extra,
  };
}

function mutationPayload(stage: "PROPOSED" | "VALIDATED" | "COMMITTED", ops: DeltaOpSummary[], rate: SupportedRate, delta = "delta_004"): TelemetryPayload {
  return {
    kind: "MUTATION_EMITTED",
    task_id: "task_cut",
    delta_id: delta,
    mutation_stage: stage,
    validation_token: stage === "PROPOSED" ? null : "vtok_8f3a",
    target_host: "resolve",
    target_timeline: "Doc Teaser v1",
    timeline_fps: rate,
    narrative_rationale: "Open on the bite.",
    operations: ops,
  };
}

const record = (ops: DeltaOpSummary[], rate: SupportedRate): Record<string, MutationRecord> => ({
  d: {
    delta_id: "d",
    task_id: "t",
    subagent: "PACING_CUTTER",
    mutation_stage: "COMMITTED",
    validation_token: null,
    target_host: "premiere",
    target_timeline: "Cut",
    timeline_fps: rate,
    narrative_rationale: "",
    operations: ops,
    seq_id: 1,
    first_seq_id: 1,
  },
});

describe("the OTIO dock's lanes", () => {
  it("places clips by exact RationalTime at 23.976 and 29.97", () => {
    // An hour in at 23.976 is 86,400 frames = 3603.6 s; at 10 px/s that's x = 36,036.
    const at23 = buildTracks(record([op("op_001", "INSERT_CLIP", "Video", 2, 86400, 240, 23.976)], 23.976), 10);
    const clip23 = at23.find((t) => t.label === "V2")!.clips[0];
    expect(clip23.x).toBe(36036);
    expect(clip23.width).toBe(Math.round((86640 * 1001) / 24000 * 10) - 36036);
    // 29.97: 30,000 frames is 1,001 s.
    const at29 = buildTracks(record([op("op_002", "TRIM_CLIP", "Video", 1, 30000, 30, 29.97)], 29.97), 1);
    expect(at29.find((t) => t.label === "V1")!.clips[0].x).toBe(1001);
    expect(timelineSeconds(record([op("op_002", "TRIM_CLIP", "Video", 1, 30000, 30, 29.97)], 29.97))).toBeCloseTo(1002.001, 3);
  });

  it("always has V2, V1, A1, A2 and adds other tracks in order", () => {
    const tracks = buildTracks(record([op("op_1", "INSERT_CLIP", "Video", 3, 0, 10, 24), op("op_2", "SET_AUDIO_GAIN", "Audio", 4, 0, 10, 24)], 24), 10);
    expect(tracks.map((t) => t.label)).toEqual(["V3", "V2", "V1", "A1", "A2", "A4"]);
  });

  it("draws a duck's envelope with its ramps, and reads trim deltas", () => {
    expect(duckEnvelopePath(200, 30, 10, -12)).toBe("M 0 3 L 10 9.75 L 190 9.75 L 200 3");
    expect(duckEnvelopePath(10, 30, 10, -12)).toBe("M 0 3 L 5 9.75 L 5 9.75 L 10 3");
    expect(duckEnvelopePath(100, 30, 10, -6, false)).toBe("M 0 6.38 L 100 6.38");
    expect(trimDeltaFrames(op("t", "TRIM_CLIP", "Video", 1, 0, 100, 24, { source_range: tr(0, 112, 24) }))).toBe(-12);
  });
});

describe("OtioTimelineDock", () => {
  beforeEach(() => useVisualizerStore.getState().reset());

  it("shows each mutation kind with its diff badge and the delta's stage", () => {
    const ops = [
      op("op_001", "INSERT_CLIP", "Video", 2, 240, 302, 23.976),
      op("op_002", "TRIM_CLIP", "Video", 1, 0, 1188, 23.976, { source_range: tr(1726, 1200, 23.976) }),
      op("op_003", "SPLIT_CLIP", "Video", 1, 1188, 100, 23.976),
      op("op_004", "DELETE_CLIP", "Audio", 1, 0, 48, 23.976, { ripple: true }),
      op("op_005", "INSERT_GAP", "Video", 1, 2000, 24, 23.976),
      op("op_006", "DUCK_REGION", "Audio", 2, 0, 2148, 23.976, { gain_db: -12 }),
    ];
    render(<OtioTimelineDock />);
    act(() => useVisualizerStore.getState().applyBatch([env(1, mutationPayload("PROPOSED", ops, 23.976), { subagent: "PACING_CUTTER" })]));
    expect(screen.getByTestId("delta-stage")).toHaveTextContent("PROPOSED");
    const insert = document.querySelector('[data-op-type="INSERT_CLIP"]') as HTMLElement;
    expect(insert).toHaveClass("clip-enter");
    expect(insert.style.borderColor).toBe("rgb(0, 200, 83)");
    expect(screen.getByText("−12f")).toBeInTheDocument();
    expect(screen.getByTestId("razor")).toBeInTheDocument();
    expect(screen.getByText("⟵ ripple")).toBeInTheDocument();
    expect(screen.getByText(/» » » 24f/)).toBeInTheDocument();
    expect(screen.getByTestId("gain-envelope").getAttribute("d")).toMatch(/^M 0 \d/);
    expect(screen.getAllByTestId("attribution")[0]).toHaveTextContent("[CUTTER · op_001]");
    expect(screen.queryAllByTestId("lock")).toHaveLength(0);

    act(() => useVisualizerStore.getState().applyBatch([env(2, mutationPayload("COMMITTED", ops, 23.976), { subagent: "PACING_CUTTER" })]));
    expect(screen.getByTestId("delta-stage")).toHaveTextContent("COMMITTED ✓");
    expect(screen.getAllByTestId("lock").length).toBe(ops.length);
    expect((document.querySelector('[data-op-type="INSERT_CLIP"]') as HTMLElement).className).not.toContain("clip-enter");
  });

  it("draws a streamed waveform under the duck and highlights the agent on hover", () => {
    const ops = [op("op_001", "DUCK_REGION", "Audio", 2, 0, 480, 29.97, { gain_db: -12 })];
    render(<OtioTimelineDock />);
    act(() => {
      useVisualizerStore.getState().applyBatch([env(7, mutationPayload("COMMITTED", ops, 29.97), { subagent: "AUDIO_ENGINEER" })]);
      useVisualizerStore.getState().addWaveform(7, [-0.5, 0.5, -0.25, 0.25]);
    });
    expect(screen.getByTestId("waveform")).toBeInTheDocument();
    expect(screen.getByTestId("playhead-tc")).toHaveTextContent("00:00:00;00");
    act(() => {
      (document.querySelector('[data-op-type="DUCK_REGION"]') as HTMLElement).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(useVisualizerStore.getState().hoveredTaskId).toBe("task_cut");
  });
});
