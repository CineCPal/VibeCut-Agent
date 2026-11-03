/**
 * The log at 100,000 rows (PLAN.md, "Phase 22", "The log at 100k rows"): a run that size goes through the
 * real store in the gateway's 128-event batches and into the virtualized dock. The timings are budgets with
 * room for a loaded machine, not benchmarks; `--silent=false` prints the measured ones.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ACTIVE_PACKETS } from "../../lib/studio/packets";
import { MAX_LOGS } from "../../lib/reconciler/reduce";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { completed, env, spawn, tool, waiting } from "../../test/envelopes";
import { ROW_PX, TerminalReplayDock } from "./TerminalReplayDock";

const ROWS = 100_000;
const TASKS = 200;
const BATCH = 128;

/** Like stress_emitter.py: a root, 200 workers, their tool calls (every 25th a GPU wait), completions. */
function run(): TelemetryEnvelope[] {
  const rows: TelemetryEnvelope[] = [env(1, spawn("task_root"), { parent: null, agent: "orchestrator.supervisor", subagent: "MASTER_ORCHESTRATOR" })];
  for (let i = 0; i < TASKS; i++) rows.push(env(rows.length + 1, spawn(`task_${i}`)));
  while (rows.length < ROWS - TASKS) {
    const task = `task_${rows.length % TASKS}`;
    rows.push(env(rows.length + 1, rows.length % 25 === 0 ? waiting(task) : tool(task)));
  }
  for (let i = 0; i < TASKS; i++) rows.push(env(rows.length + 1, completed(`task_${i}`)));
  return rows;
}

function ingest(rows: TelemetryEnvelope[]): number[] {
  const times: number[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const began = performance.now();
    useVisualizerStore.getState().applyBatch(rows.slice(i, i + BATCH), 1_000_000);
    times.push(performance.now() - began);
  }
  return times;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("the log at 100,000 rows", () => {
  const rows = run();
  // jsdom has no layout: give elements a client size (what the virtualizer reads), so it has a window to fill.
  const sized: Record<string, PropertyDescriptor | undefined> = {};
  beforeAll(() => {
    for (const [name, value] of [["clientHeight", 240], ["clientWidth", 800]] as const) {
      sized[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    }
  });
  afterAll(() => {
    for (const [name, descriptor] of Object.entries(sized)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });
  beforeEach(() => {
    localStorage.clear();
    useVisualizerStore.getState().reset();
  });

  it("takes the run live in batches without each batch costing more as the log grows", () => {
    const began = performance.now();
    const times = ingest(rows);
    const total = performance.now() - began;
    const live = useVisualizerStore.getState().live;
    expect(live.logs).toHaveLength(ROWS);
    expect(Object.isFrozen(live.logs)).toBe(true);
    expect(live.activePackets.length).toBeLessThanOrEqual(MAX_ACTIVE_PACKETS);
    expect(Object.keys(live.nodes)).toHaveLength(TASKS + 1);
    const early = mean(times.slice(10, 110));
    const late = mean(times.slice(-100));
    console.log(`ingest: ${Math.round(total)} ms for ${times.length} batches; ${early.toFixed(2)} ms a batch early, ${late.toFixed(2)} ms at 100k`);
    expect(total).toBeLessThan(6_000);
    // Flat: a batch at 100k rows costs about what it did at 2k (it was O(log size) under Immer).
    expect(late).toBeLessThan(early * 3 + 1);
  }, 60_000);

  it("drops the oldest rows once a run passes 110,000, keeping at least the newest 100,000", () => {
    const more = run().map((e) => ({ ...e, seq_id: e.seq_id + ROWS, event_id: `${e.event_id}_b` }));
    ingest(rows);
    ingest(more.slice(0, 15_000));
    const logs = useVisualizerStore.getState().live.logs;
    // Cut back to 100,000 in the batch that passed 110,000 (at a batch's end, so a little after), then grown.
    expect(logs.length).toBeGreaterThanOrEqual(MAX_LOGS);
    expect(logs.length).toBeLessThan(MAX_LOGS + 5_000);
    expect(logs.at(-1)?.seq_id).toBe(ROWS + 15_000);
    expect(logs[0].seq_id).toBe(ROWS + 15_000 - logs.length + 1);
  }, 60_000);

  it("hydrates a 100k-row snapshot at once", () => {
    const began = performance.now();
    act(() => useVisualizerStore.getState().hydrateSnapshot("trc_test", ROWS, rows));
    const took = performance.now() - began;
    console.log(`hydrate: ${Math.round(took)} ms`);
    expect(useVisualizerStore.getState().live.logs).toHaveLength(ROWS);
    expect(took).toBeLessThan(2_000);
  }, 60_000);

  // Following the tail needs a browser that scrolls: see the stress run in PLAN.md.
  it("draws only a window of rows wherever it's scrolled, and searches all 100k", () => {
    act(() => useVisualizerStore.getState().hydrateSnapshot("trc_test", ROWS, rows));
    render(<TerminalReplayDock collapsible={false} />);
    expect(screen.getByText(`${ROWS.toLocaleString("en-US")}/${ROWS.toLocaleString("en-US")}`)).toBeInTheDocument();
    const drawn = () => [...document.querySelectorAll<HTMLElement>("[data-seq]")].map((el) => Number(el.dataset.seq));
    expect(drawn().length).toBeGreaterThan(0);
    expect(drawn().length).toBeLessThanOrEqual(60);

    // Halfway down: the rows there, still only a window of them.
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollTop", { configurable: true, value: 50_000 * ROW_PX });
    act(() => void log.dispatchEvent(new Event("scroll")));
    const middle = drawn();
    expect(middle.length).toBeLessThanOrEqual(60);
    expect(Math.min(...middle)).toBeLessThanOrEqual(50_001);
    expect(Math.max(...middle)).toBeGreaterThanOrEqual(50_010);
    expect(Math.min(...middle)).toBeGreaterThan(49_900);

    const began = performance.now();
    fireEvent.change(screen.getByPlaceholderText("op_003 or /regex/i"), { target: { value: "WAIT task_25 " } });
    const took = performance.now() - began;
    const waits = rows.filter((e) => e.event_type === "WAITING_UPSTREAM" && "task_id" in e.payload && e.payload.task_id === "task_25").length;
    console.log(`search: ${Math.round(took)} ms, ${waits} rows`);
    expect(waits).toBeGreaterThan(0);
    expect(screen.getByText(`${waits.toLocaleString("en-US")}/${ROWS.toLocaleString("en-US")}`)).toBeInTheDocument();
    expect(took).toBeLessThan(1_500);
    expect(document.querySelectorAll("[data-seq]").length).toBeLessThanOrEqual(60);
  }, 60_000);
});
