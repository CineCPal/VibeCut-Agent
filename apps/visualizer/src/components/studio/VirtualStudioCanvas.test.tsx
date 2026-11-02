import type { SubagentType, TelemetryPayload } from "@vibecut/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avatarOnEvent, effectiveAvatar, idleBay, CELEBRATE_MS, GPU_WAIT_BLOCKED_MS } from "../../lib/studio/avatarFsm";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { completed, env, failed, handoff, planning, spawn, tool, waiting } from "../../test/envelopes";
import { isStudioIdle, VirtualStudioCanvas } from "./VirtualStudioCanvas";
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
    useVisualizerStore.getState().reset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it("mounts without a canvas context and lists the bays for keyboard and screen readers", () => {
    render(<VirtualStudioCanvas />);
    expect(screen.getByRole("img", { name: /Virtual editing studio/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.getByRole("button", { name: /Bay 4: Assembly & Pacing Bench, idle/ })).toBeDisabled();
  });

  it("shows each lifecycle event on its bay and selects the bay's task", () => {
    render(<VirtualStudioCanvas />);
    const now = Date.now();
    const sub = (s: SubagentType) => ({ subagent: s, t: now });
    act(() =>
      useVisualizerStore.getState().applyBatch(
        [
          env(1, spawn("task_root"), { ...sub("MASTER_ORCHESTRATOR"), parent: null }),
          env(2, tool("task_v"), sub("VISION_TAGGER")),
          env(3, waiting("task_a"), sub("AUDIO_ENGINEER")),
          env(4, failed("task_n"), sub("COLOR_GRADER")),
        ],
        now,
      ),
    );
    const bay = (s: string) => document.querySelector(`[data-subagent="${s}"]`) as HTMLButtonElement;
    expect(bay("MASTER_ORCHESTRATOR").dataset.avatarState).toBe("PROCESSING_THINKING");
    expect(bay("VISION_TAGGER").dataset.avatarState).toBe("READING_ASSET");
    expect(bay("AUDIO_ENGINEER").dataset.avatarState).toBe("LISTENING");
    expect(bay("COLOR_GRADER").dataset.avatarState).toBe("BLOCKED_ERROR");
    act(() => bay("VISION_TAGGER").click());
    expect(useVisualizerStore.getState().selectedTaskId).toBe("task_v");
    expect(bay("VISION_TAGGER")).toHaveAttribute("aria-pressed", "true");
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
