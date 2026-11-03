import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useVisualizerStore, type HostHealth } from "../../store/useVisualizerStore";
import { TopTelemetryBar } from "./TopTelemetryBar";

const health = (premiere: boolean, resolve: boolean): HostHealth => ({
  status: "ok",
  version: "1",
  active_trace_id: null,
  connected_clients: 1,
  host_metrics: { nle_connected: { premiere, resolve } },
  workers: {},
});

describe("the top bar's editor status", () => {
  beforeEach(() => useVisualizerStore.getState().reset());

  it("comes from the gateway's live health, with no run going", () => {
    render(<TopTelemetryBar />);
    expect(screen.getByTestId("editor-status")).toHaveTextContent("–");
    act(() => useVisualizerStore.getState().setHostHealth(health(true, false)));
    expect(screen.getByTestId("editor-status")).toHaveTextContent("Premiere");
    act(() => useVisualizerStore.getState().setHostHealth(health(true, true)));
    expect(screen.getByTestId("editor-status")).toHaveTextContent("Premiere + Resolve");
    act(() => useVisualizerStore.getState().setHostHealth(health(false, false)));
    expect(screen.getByTestId("editor-status")).toHaveTextContent("none");
  });
});
