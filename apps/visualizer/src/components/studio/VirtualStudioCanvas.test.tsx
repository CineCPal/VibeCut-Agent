import type { SubagentType, TelemetryPayload } from "@vibecut/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avatarOnEvent, effectiveAvatar, idleBay, CELEBRATE_MS, GPU_WAIT_BLOCKED_MS } from "../../lib/studio/avatarFsm";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { completed, env, failed, handoff, planning, spawn, tool, waiting } from "../../test/envelopes";
import { STATIONS } from "../../lib/studio/stations";
import { guestsOf, isStudioIdle, VirtualStudioCanvas } from "./VirtualStudioCanvas";
import type { AvatarState } from "../../types/studio";

const mutation = (stage: "PROPOSED" | "VALIDATED" | "COMMITTED" | "ROLLED_BACK"): TelemetryPayload => ({
  kind: "MUTATION_EMITTED",
  task_id: "t",
  delta_id: "delta_1",
  mutation_stage: stage,
  validation_token: null,
  target_host: "resolve",
  target_timeline: "Cut",
  timeline_fps: 23.976,
  narrative_rationale: "why",
  operations: [],
});

describe("the avatar state machine", () => {
  const cases: [string, TelemetryPayload, AvatarState][] = [
    ["SPAWN", spawn("t"), "PROCESSING_THINKING"],
    ["PLANNING", planning("t"), "PROCESSING_THINKING"],
    ["TOOL_INVOCATION (read)", tool("t", "analyze_shot_visuals"), "READING_ASSET"],
    ["TOOL_INVOCATION (delta)", tool("t", "propose_otio_delta"), "WRITING_OTIO"],
    ["TOOL_INVOCATION (commit)", tool("t", "commit_otio_delta"), "RENDERING"],
    ["WAITING_UPSTREAM", waiting("t"), "LISTENING"],
    ["MUTATION_EMITTED (proposed)", mutation("PROPOSED"), "WRITING_OTIO"],
    ["MUTATION_EMITTED (committed)", mutation("COMMITTED"), "RENDERING"],
    ["MUTATION_EMITTED (rolled back)", mutation("ROLLED_BACK"), "BLOCKED_ERROR"],
    ["COMPLETED", completed("t"), "SUCCESS_CELEBRATE"],
    ["FAILED", failed("t"), "BLOCKED_ERROR"],
  ];
  it.each(cases)("%s", (_name, payload, expected) => {
    const bay = idleBay("VISION_TAGGER");
    avatarOnEvent(bay, env(1, payload, { t: 5000 }));
    expect(bay.avatar).toBe(expected);
  });

  it("settles a success to idle and shows a long GPU wait as blocked", () => {
    const bay = idleBay("VISION_TAGGER");
    avatarOnEvent(bay, env(1, completed("t", 284), { t: 1000 }));
    expect(bay.hud).toBe("✓ 284ms");
    expect(effectiveAvatar(bay, 1000 + CELEBRATE_MS - 1)).toBe("SUCCESS_CELEBRATE");
    expect(effectiveAvatar(bay, 1000 + CELEBRATE_MS)).toBe("IDLE");
    avatarOnEvent(bay, env(2, waiting("t"), { t: 2000 }));
    expect(effectiveAvatar(bay, 2000 + GPU_WAIT_BLOCKED_MS)).toBe("LISTENING");
    expect(effectiveAvatar(bay, 2001 + GPU_WAIT_BLOCKED_MS)).toBe("BLOCKED_ERROR");
    avatarOnEvent(bay, env(3, spawn("t"), { t: 9000 }));
    expect(bay.avatar).toBe("PROCESSING_THINKING");
  });
});

describe("VirtualStudioCanvas", () => {
  beforeEach(() => {
    localStorage.removeItem("vibecut.visualizer.studioStyle");
    useVisualizerStore.getState().reset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it("mounts without a canvas context and lists every workstation for keyboard and screen readers", () => {
    render(<VirtualStudioCanvas />);
    expect(screen.getByRole("img", { name: /Virtual edit suite \(Suite\): 7 rooms/ })).toBeInTheDocument();
    // A button per desk, and the two style buttons.
    expect(screen.getAllByRole("button")).toHaveLength(STATIONS.length + 2);
    expect(screen.getByRole("button", { name: /Assembly & Pacing, OTIO cutter: idle/ })).toBeDisabled();
  });

  it("shows each agent's events at its own desk, not its room's others, and selects the desk's task", () => {
    render(<VirtualStudioCanvas />);
    const now = Date.now();
    const at = (s: SubagentType, agent: string) => ({ subagent: s, agent, t: now });
    act(() =>
      useVisualizerStore.getState().applyBatch(
        [
          env(1, spawn("task_root"), { ...at("MASTER_ORCHESTRATOR", "orchestrator.supervisor"), parent: null }),
          env(2, tool("task_v"), at("VISION_TAGGER", "worker.vlm.01")),
          env(3, waiting("task_a"), at("AUDIO_ENGINEER", "app.audio_sync")),
          env(4, failed("task_n"), at("COLOR_GRADER", "app.markers")),
        ],
        now,
      ),
    );
    const desk = (key: string) => document.querySelector(`[data-station="${key}"]`) as HTMLButtonElement;
    expect(desk("orchestrator.supervisor").dataset.avatarState).toBe("PROCESSING_THINKING");
    expect(desk("worker.vlm").dataset.avatarState).toBe("READING_ASSET");
    expect(desk("app.audio_sync").dataset.avatarState).toBe("LISTENING");
    expect(desk("app.markers").dataset.avatarState).toBe("BLOCKED_ERROR");
    // The room's other desks stay idle.
    expect(desk("app.thumbnails").dataset.avatarState).toBe("IDLE");
    expect(desk("worker.color_nle").dataset.avatarState).toBe("IDLE");
    act(() => desk("worker.vlm").click());
    expect(useVisualizerStore.getState().selectedTaskId).toBe("task_v");
    expect(desk("worker.vlm")).toHaveAttribute("aria-pressed", "true");
  });

  it("switches between the suite and compact styles, remembering the choice", () => {
    render(<VirtualStudioCanvas />);
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(screen.getByRole("button", { name: "Suite" })).toHaveAttribute("aria-pressed", "true");
    act(() => compact.click());
    expect(compact).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /Virtual edit suite \(Compact\)/ })).toBeInTheDocument();
    expect(localStorage.getItem("vibecut.visualizer.studioStyle")).toBe("compact");
    // Every desk is still there, and a reset (a new store) reads the choice back.
    expect(document.querySelectorAll("[data-station]")).toHaveLength(STATIONS.length);
    act(() => useVisualizerStore.getState().reset());
    expect(useVisualizerStore.getState().studioStyle).toBe("compact");
    act(() => useVisualizerStore.getState().cycleStudioStyle());
    expect(useVisualizerStore.getState().studioStyle).toBe("suite");
    expect(localStorage.getItem("vibecut.visualizer.studioStyle")).toBe("suite");
  });

  it("gives an unlisted agent a desk in its room", () => {
    render(<VirtualStudioCanvas />);
    const now = Date.now();
    act(() =>
      useVisualizerStore.getState().applyBatch([env(1, tool("task_x"), { subagent: "PACING_CUTTER", agent: "app.brand_new", t: now })], now),
    );
    expect(guestsOf(useVisualizerStore.getState().live)).toEqual({ PACING_CUTTER: ["app.brand_new"] });
    const desk = document.querySelector('[data-station="app.brand_new"]') as HTMLButtonElement;
    expect(desk.dataset.subagent).toBe("PACING_CUTTER");
    expect(screen.getAllByRole("button")).toHaveLength(STATIONS.length + 3);
  });

  it("spawns packet beams for handoffs, tool calls and mutations, and idles without them", () => {
    const now = Date.now();
    act(() =>
      useVisualizerStore.getState().applyBatch(
        [
          env(1, handoff("a", "b", "INGEST_TRANSCRIBE", "BROLL_RETRIEVER"), { t: now }),
          env(2, tool("v"), { subagent: "VISION_TAGGER", t: now }),
          env(3, mutation("COMMITTED"), { subagent: "PACING_CUTTER", t: now }),
        ],
        now,
      ),
    );
    const packets = useVisualizerStore.getState().live.activePackets;
    expect(packets.map((p) => [p.from, p.to, p.packet_type])).toEqual([
      ["INGEST_TRANSCRIBE", "BROLL_RETRIEVER", "CLIP_MANIFEST"],
      ["MASTER_ORCHESTRATOR", "VISION_TAGGER", "PROMPT_TOKENS"],
      ["PACING_CUTTER", "COLOR_GRADER", "NLE_COMMIT_BATCH"],
    ]);
    const live = useVisualizerStore.getState().live;
    expect(isStudioIdle(live, now)).toBe(false);
    useVisualizerStore.getState().reset();
    expect(isStudioIdle(useVisualizerStore.getState().live, now)).toBe(true);
  });
});
