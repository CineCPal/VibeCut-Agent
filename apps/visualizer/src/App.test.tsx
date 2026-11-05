/**
 * End to end over the four panes: the mock documentary run (the Python emitter's fixture) from SPAWN
 * through MUTATION_EMITTED and COMPLETED, then time travel back to the proposal and forward to live.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resolveHostAdapter } from "./lib/host/runtimeHostAdapter";
import { mockTrace } from "./lib/reconciler/mockTraceGenerator";
import { TelemetryReconciler } from "./lib/reconciler/TelemetryReconciler";
import { useVisualizerStore } from "./store/useVisualizerStore";

const adapter = resolveHostAdapter({ search: "?source=mock", hostname: "localhost", host: "localhost:5173", protocol: "http:" });

function play(count?: number) {
  const run = mockTrace(undefined, Date.now());
  const reconciler = new TelemetryReconciler({
    onFlush: (envs) => useVisualizerStore.getState().applyBatch(envs),
    scheduleFrame: () => undefined,
  });
  act(() => {
    reconciler.ingest(count === undefined ? run : run.slice(0, count));
    reconciler.flush();
  });
  return run;
}

describe("App", () => {
  beforeEach(() => {
    // The collapsed docks are remembered in the browser: start every test with both open.
    localStorage.clear();
    useVisualizerStore.getState().reset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    // jsdom has no layout: give the log's scroll box a height so the virtualizer renders rows.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  });
  afterEach(() => vi.restoreAllMocks());

  it("follows a documentary rough cut through every pane", () => {
    render(<App adapter={adapter} />);
    expect(screen.getByText("Waiting for the first task…")).toBeInTheDocument();

    // The first few events: the orchestrator spawns and plans.
    play(4);
    expect(screen.getByText(/Events: 4/)).toBeInTheDocument();
    const bridge = document.querySelector('[data-subagent="MASTER_ORCHESTRATOR"]') as HTMLElement;
    expect(bridge.dataset.avatarState).toBe("PROCESSING_THINKING");

    useVisualizerStore.getState().reset();
    const run = play();
    const dag = screen.getByRole("group", { name: "Execution DAG, 7 tasks" });
    expect(screen.getByRole("combobox", { name: /Trace/ })).toHaveValue("trc_mock_0001");

    // Pane B: the committed delta's four ops on V2, V1 and A2.
    const dock = screen.getByRole("region", { name: "OTIO live preview" });
    expect(within(dock).getByTestId("delta-stage")).toHaveTextContent("COMMITTED ✓");
    expect(within(dock).getAllByTestId("lock")).toHaveLength(4);
    expect(within(dock).getByText("[CUTTER · op_002]")).toBeInTheDocument();
    expect(within(dock).getByTestId("gain-envelope")).toBeInTheDocument();

    // Pane C: select the cutter in the DAG.
    fireEvent.click(within(dag).getByRole("button", { name: /Assemble the teaser/ }));
    const inspector = screen.getByRole("complementary", { name: "Agent inspector" });
    expect(within(inspector).getByRole("heading", { name: /CUTTER: Assemble the teaser/ })).toBeInTheDocument();
    expect(within(inspector).getByTestId("thought-stream")).toHaveTextContent("Matching interview bite at 00:01:12 with kinetic B-roll shot_042...");
    expect(within(inspector).getByText(/Validation: valid \(deterministic\)/)).toBeInTheDocument();
    expect(within(inspector).getByText("propose_otio_delta")).toBeInTheDocument();
    expect(within(inspector).getByText(/1,420 → 390/)).toBeInTheDocument();

    // The vision tagger's artifact shows its contact strip slot.
    fireEvent.click(within(dag).getByRole("button", { name: /Tag drone shots/ }));
    expect(within(inspector).getByRole("figure", { name: "Contact strip of B004_Drone.mov" })).toBeInTheDocument();
    expect(within(inspector).getByText("EWS")).toBeInTheDocument();

    // The audio engineer failed once and was retried.
    fireEvent.click(within(dag).getByRole("button", { name: /Sync and loudness/ }));
    expect(within(inspector).queryByRole("alert")).toBeNull();

    // Pane D: the log, filtered and searched.
    const log = screen.getByRole("region", { name: "Terminal and replay log" });
    expect(within(log).getByText(`${run.length}/${run.length}`)).toBeInTheDocument();
    fireEvent.click(within(log).getByRole("button", { name: "ALL" }));
    fireEvent.click(within(log).getByRole("button", { name: "MUTATION" }));
    expect(within(log).getByText(`3/${run.length}`)).toBeInTheDocument();
    fireEvent.change(within(log).getByRole("searchbox"), { target: { value: "/COMMITTED/" } });
    expect(within(log).getByText(`1/${run.length}`)).toBeInTheDocument();
    expect(within(log).getByText(/MUTATION_EMITTED delta_004 COMMITTED \(4 ops/)).toBeInTheDocument();
    fireEvent.change(within(log).getByRole("searchbox"), { target: { value: "/[unclosed/" } });
    expect(within(log).getByRole("alert")).toHaveTextContent("Bad regex");
  });

  it("scrubs back to the proposal and returns to live", () => {
    render(<App adapter={adapter} />);
    const run = play();
    const proposed = run.find((e) => e.payload.kind === "MUTATION_EMITTED")!.seq_id;
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: String(proposed) } });
    expect(screen.getByText(`Replay @ ${proposed}`)).toBeInTheDocument();
    expect(screen.getByTestId("replay-position")).toHaveTextContent(`${proposed} / ${run.length}`);
    expect(screen.getByTestId("delta-stage")).toHaveTextContent("PROPOSED");
    // The NLE commit task hadn't been spawned yet.
    const dag = () => screen.getByRole("group", { name: /Execution DAG/ });
    expect(within(dag()).queryByRole("button", { name: /Commit to Resolve/ })).toBeNull();
    fireEvent.keyDown(window, { key: "." });
    expect(useVisualizerStore.getState().replayCursorSeqId).toBe(proposed + 1);
    fireEvent.keyDown(window, { key: "," });
    fireEvent.keyDown(window, { key: "," });
    expect(useVisualizerStore.getState().replayCursorSeqId).toBe(proposed - 1);
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByTestId("delta-stage")).toHaveTextContent("COMMITTED");
    expect(within(dag()).getByRole("button", { name: /Commit to Resolve/ })).toBeInTheDocument();
  });

  it("switches views by key and shows About This App", () => {
    render(<App adapter={adapter} />);
    play();
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.queryByRole("img", { name: /Virtual edit suite/ })).toBeNull();
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.queryByRole("group", { name: /Execution DAG/ })).toBeNull();
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("img", { name: /Virtual edit suite \(Suite\)/ })).toBeInTheDocument();
    // S switches the studio's style, and back.
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByRole("img", { name: /Virtual edit suite \(Compact\)/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "S" });
    expect(screen.getByRole("img", { name: /Virtual edit suite \(Suite\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    const dialog = screen.getByRole("dialog", { name: "About VibeCut Agent Telemetry Studio" });
    expect(within(dialog).getByText(/1\.0\.0 \(vibecut\.visualizer\.spec\.v1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/No external APIs/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Resolve: connected/)).toBeInTheDocument();
    expect(within(dialog).getByText(/METAL_MPS/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("collapses the OTIO preview and the log to their headers, by their titles or T and L, and remembers it", () => {
    render(<App adapter={adapter} />);
    play();
    const otio = screen.getByRole("button", { name: "OTIO Live Preview" });
    const tracks = () => document.getElementById("otio-tracks") as HTMLElement;
    const log = () => document.getElementById("telemetry-log") as HTMLElement;
    expect(otio).toHaveAttribute("aria-expanded", "true");
    expect(otio).toHaveAttribute("aria-controls", "otio-tracks");
    fireEvent.click(otio);
    expect(otio).toHaveAttribute("aria-expanded", "false");
    expect(tracks()).not.toBeVisible();
    // The header still says how the latest delta stands; its rationale goes with the tracks.
    expect(screen.getByTestId("delta-stage")).toHaveTextContent("COMMITTED");
    const rationale = useVisualizerStore.getState().live.mutations;
    for (const m of Object.values(rationale)) expect(screen.queryByTitle(m.narrative_rationale)).toBeNull();
    fireEvent.keyDown(window, { key: "l" });
    expect(log()).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Terminal & Replay Log" })).toHaveAttribute("aria-expanded", "false");
    // The scrubber stays in the log's header.
    expect(screen.getByRole("slider")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("vibecut.visualizer.collapsedDocks") ?? "{}")).toEqual({ otio: true, log: true });
    expect(document.querySelector("main")?.className).toContain("grid-rows-[minmax(0,1fr)_auto]");
    fireEvent.keyDown(window, { key: "T" });
    expect(tracks()).toBeVisible();
    // Typing in the log's search box doesn't toggle anything.
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "t" });
    expect(tracks()).toBeVisible();
    // Opened again on the next visit as left.
    act(() => useVisualizerStore.getState().reset());
    expect(useVisualizerStore.getState().collapsedDocks).toEqual({ otio: false, log: true });
  });

  it("opens both docks when the browser won't store the choice", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => useVisualizerStore.getState().reset());
    expect(useVisualizerStore.getState().collapsedDocks).toEqual({ otio: false, log: false });
    render(<App adapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: "OTIO Live Preview" }));
    expect(useVisualizerStore.getState().collapsedDocks.otio).toBe(true);
  });

  it("lays out one column with tabs in a narrow Premiere panel", () => {
    const cep = resolveHostAdapter({ search: "?mode=embedded_cep&source=mock", hostname: "", host: "", protocol: "http:" });
    render(<App adapter={cep} />);
    play();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Studio", "Inspector", "OTIO", "Log"]);
    act(() => useVisualizerStore.setState({ collapsedDocks: { otio: true, log: true } }));
    fireEvent.click(screen.getByRole("tab", { name: "OTIO" }));
    expect(screen.getByRole("region", { name: "OTIO live preview" })).toBeInTheDocument();
    // A tab's dock doesn't collapse: no toggle, and its tracks show.
    expect(screen.queryByRole("button", { name: "OTIO Live Preview" })).toBeNull();
    expect(document.getElementById("otio-tracks")).toBeVisible();
  });

  it("opens the inspector as a sheet when a DAG task is chosen in the narrow panel", () => {
    const cep = resolveHostAdapter({ search: "?mode=embedded_cep&source=mock", hostname: "", host: "", protocol: "http:" });
    render(<App adapter={cep} />);
    play();
    expect(screen.queryByRole("dialog", { name: "Task inspector" })).toBeNull();
    const dag = screen.getByRole("group", { name: /Execution DAG/ });
    fireEvent.click(within(dag).getByRole("button", { name: /Assemble the teaser/ }));
    const sheet = screen.getByRole("dialog", { name: "Task inspector" });
    expect(within(sheet).getByRole("complementary", { name: "Agent inspector" })).toHaveTextContent("Assemble the teaser");
    // ✕ hides it; the task stays chosen. Choosing another opens it again.
    fireEvent.click(within(sheet).getByRole("button", { name: "Close the inspector" }));
    expect(screen.queryByRole("dialog", { name: "Task inspector" })).toBeNull();
    expect(useVisualizerStore.getState().selectedTaskId).not.toBeNull();
    fireEvent.click(within(dag).getByRole("button", { name: /Tag drone shots/ }));
    expect(screen.getByRole("dialog", { name: "Task inspector" })).toHaveTextContent("Tag drone shots");
    // Esc deselects, which closes it; on the Inspector tab itself there's no sheet.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Task inspector" })).toBeNull();
    fireEvent.click(within(dag).getByRole("button", { name: /Assemble the teaser/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Task inspector" })).getByRole("button", { name: "Open as tab" }));
    expect(screen.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "Task inspector" })).toBeNull();
  });
});
