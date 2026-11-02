import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTrace } from "../../lib/reconciler/mockTraceGenerator";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { clampZoom, COMPACT_BELOW, DagCanvas, fitViewport, MIN_ZOOM } from "./DagCanvas";

describe("DagCanvas", () => {
  beforeEach(() => {
    useVisualizerStore.getState().reset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  it("draws the mock run's tasks and edges, and selects one with its neighbours", () => {
    const run = mockTrace();
    act(() => useVisualizerStore.getState().hydrateSnapshot("trc_mock_0001", run.length, run));
    render(<DagCanvas />);
    expect(screen.getByRole("group", { name: "Execution DAG, 7 tasks" })).toBeInTheDocument();
    const kinds = [...document.querySelectorAll("path[data-edge-kind]")].map((p) => p.getAttribute("data-edge-kind"));
    // The commit task's parent (the root) isn't one of its upstreams, so it gets a spawn-parent edge too.
    expect(new Set(kinds)).toEqual(new Set(["DATA_DEPENDENCY", "CONTEXT_HANDOFF", "SPAWN_PARENT"]));
    const cutter = screen.getByRole("button", { name: /Assemble the teaser/ });
    expect(cutter).toHaveAttribute("data-status", "COMPLETED");
    fireEvent.click(cutter);
    expect(useVisualizerStore.getState().selectedTaskId).toBe("task_cut_006");
    expect(cutter).toHaveAttribute("aria-pressed", "true");
    // Not a neighbour of the cutter: dimmed.
    expect((screen.getByRole("button", { name: /Transcribe interviews/ }) as HTMLElement).style.opacity).toBe("0.35");
    // A neighbour: lit.
    expect((screen.getByRole("button", { name: /Commit to Resolve/ }) as HTMLElement).style.opacity).toBe("1");
    fireEvent.click(screen.getByRole("group"));
    expect(useVisualizerStore.getState().selectedTaskId).toBeNull();
  });

  it("zooms within 0.1x to 4x and fits the graph to the box", () => {
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.01)).toBe(0.1);
    const fit = fitViewport(1000, 400, 600, 400);
    expect(fit.scale).toBeCloseTo(536 / 1000, 3);
    expect(fit.x).toBeCloseTo((600 - 1000 * fit.scale) / 2, 3);
    render(<DagCanvas />);
    const zoomed = () => (document.querySelector("[data-zoom]") as HTMLElement).dataset.zoom;
    const group = screen.getByRole("group");
    fireEvent.wheel(group, { deltaY: -100000, clientX: 0, clientY: 0 });
    expect(zoomed()).toBe("4.00");
    fireEvent.keyDown(window, { key: "f" });
    expect(zoomed()).not.toBe("4.00");
  });

  it("shows compact cards with a readable label when zoomed out", () => {
    const run = mockTrace();
    act(() => useVisualizerStore.getState().hydrateSnapshot("trc_mock_0001", run.length, run));
    render(<DagCanvas />);
    const cutter = () => screen.getByRole("button", { name: /Assemble the teaser/ });
    expect(cutter()).not.toHaveAttribute("data-compact");
    fireEvent.wheel(screen.getByRole("group"), { deltaY: 100000, clientX: 0, clientY: 0 });
    expect((document.querySelector("[data-zoom]") as HTMLElement).dataset.zoom).toBe(MIN_ZOOM.toFixed(2));
    expect(cutter()).toHaveAttribute("data-compact", "true");
    // 13 px on screen would be 130 px at 0.1x: capped so a label still fits its card.
    const label = cutter().querySelector("span[style*='font-size']") as HTMLElement;
    expect(label.style.fontSize).toBe(`${40}px`);
    expect(cutter()).toHaveAttribute("title", expect.stringContaining("Assemble the teaser"));
    expect(COMPACT_BELOW).toBeGreaterThan(MIN_ZOOM);
  });
});
