import type { TelemetryPayload } from "@vibecut/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInspectorDrawer } from "../components/inspector/AgentInspectorDrawer";
import { OtioTimelineDock } from "../components/timeline/OtioTimelineDock";
import { useVisualizerStore, type HostHealth } from "../store/useVisualizerStore";
import { env, spawn, tool } from "../test/envelopes";
import { CHAT_TRACE } from "./control";

const TRACE = "trc_mcp_job-7_a1b2c3";

const health = (appControl: boolean): HostHealth => ({
  status: "ok",
  version: "1",
  active_trace_id: TRACE,
  connected_clients: 1,
  host_metrics: {},
  workers: {},
  app_control: appControl,
});

const mutation: TelemetryPayload = {
  kind: "MUTATION_EMITTED",
  task_id: "task_cut",
  delta_id: "delta_001",
  mutation_stage: "COMMITTED",
  validation_token: "vtok_1",
  target_host: "resolve",
  target_timeline: "Doc Teaser v1",
  timeline_fps: 24,
  narrative_rationale: "",
  operations: [],
};

function load(appControl: boolean) {
  const sender = vi.fn(async () => undefined);
  act(() => {
    const s = useVisualizerStore.getState();
    s.applyBatch([
      env(1, spawn("task_root"), { trace: TRACE, parent: null, subagent: "MASTER_ORCHESTRATOR" }),
      env(2, spawn("task_vis"), { trace: TRACE }),
      env(3, tool("task_vis"), { trace: TRACE }),
      env(4, mutation, { trace: TRACE, subagent: "COLOR_GRADER" }),
    ]);
    s.setHostHealth(health(appControl));
    s.setControlSender(sender);
  });
  return sender;
}

describe("the app's actions from the visualizer", () => {
  beforeEach(() => useVisualizerStore.getState().reset());

  it("knows a chat's trace from the others", () => {
    expect(CHAT_TRACE.test(TRACE)).toBe(true);
    expect(CHAT_TRACE.test("trc_ing_a1b2c3")).toBe(false);
    expect(CHAT_TRACE.test("trc_mock_0001")).toBe(false);
  });

  it("shows a task's file in Finder and stops the chat's run", async () => {
    const sender = load(true);
    act(() => useVisualizerStore.getState().selectTask("task_vis"));
    render(<AgentInspectorDrawer />);
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show a.mov in Finder" }));
    expect(sender).toHaveBeenCalledWith(TRACE, "REVEAL_IN_FINDER", { path: "/a.mov" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Shown in Finder"));

    act(() => useVisualizerStore.getState().selectTask("task_root"));
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(sender).toHaveBeenLastCalledWith(TRACE, "CANCEL", {});
  });

  it("moves the editor's playhead on the latest delta's timeline", async () => {
    const sender = load(true);
    render(<OtioTimelineDock />);
    fireEvent.click(screen.getByRole("button", { name: "Move playhead" }));
    expect(sender).toHaveBeenCalledWith(TRACE, "SET_NLE_PLAYHEAD", { host: "resolve", timeline: "Doc Teaser v1", seconds: 0 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Playhead sent: 00:00:00:00"));
  });

  it("says why when the gateway refuses", async () => {
    const sender = load(true);
    sender.mockRejectedValueOnce(new Error("path must be a file this trace's agents used"));
    act(() => useVisualizerStore.getState().selectTask("task_vis"));
    render(<AgentInspectorDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Show a.mov in Finder" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("path must be a file this trace's agents used"));
  });

  it("offers none of them when the app didn't start the gateway", () => {
    load(false);
    act(() => useVisualizerStore.getState().selectTask("task_root"));
    const { unmount } = render(<AgentInspectorDrawer />);
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    unmount();
    act(() => useVisualizerStore.getState().selectTask("task_vis"));
    render(<AgentInspectorDrawer />);
    expect(screen.getByText("a.mov")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /in Finder/ })).toBeNull();
    render(<OtioTimelineDock />);
    expect(screen.queryByRole("button", { name: "Move playhead" })).toBeNull();
  });
});
