import { beforeEach, describe, expect, it } from "vitest";
import { lastEditStep, parseSavedEditLog, savedEditLog, trimEntries, useEditLogStore } from "./useEditLogStore";
import type { EditEntry } from "../types/edits";
import type { SavedEditLog } from "../types/history";

const entry = (id: string, step: string, reverted = false): EditEntry => ({
  id,
  step,
  stepText: "tidy it",
  at: 1,
  host: "resolve",
  timeline: "Main",
  tool: "delete_clips",
  summary: `edit ${id}`,
  backup: "Main (before VibeCut 1)",
  changes: [{ kind: "deleted", name: "A.mov", itemId: "v1" }],
  ...(reverted ? { reverted: { at: 2, changedSince: 0, failed: 0, lost: [] } } : {}),
});

const saved = (entries: EditEntry[], extra: Partial<SavedEditLog> = {}): SavedEditLog => ({
  version: 1,
  entries,
  backups: { "m1|resolve|Main": "Main (before VibeCut 1)" },
  restoredIds: { premiere: {}, resolve: { old: "new" } },
  ...extra,
});

const store = () => useEditLogStore.getState();
const log = (step: string) =>
  store().log({ step, stepText: "x", host: "resolve", timeline: "Main", tool: "t", summary: "s", backup: "b", changes: [] });

describe("useEditLogStore across restarts (Phase 8a)", () => {
  beforeEach(() => {
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} }, floorSeq: 1 });
  });

  it("loads the saved log as earlier-run entries, so Revert still finds the latest request", () => {
    store().hydrate(saved([entry("e1", "m1"), entry("e2", "m2"), entry("e3", "m2")]));
    expect(store().entries.every((e) => e.fromEarlierRun)).toBe(true);
    expect(lastEditStep()).toEqual(["e2", "e3"]);
    expect(store().backups).toEqual({ "m1|resolve|Main": "Main (before VibeCut 1)" });
    expect(store().restoredIds.resolve).toEqual({ old: "new" });
  });

  it("numbers new entries after the saved ones, and after trimmed ones it no longer has", () => {
    store().hydrate(saved([entry("e4", "m1")], { nextSeq: 9 }));
    expect(log("m3").id).toBe("e9");
    expect(log("m3").id).toBe("e10");
    useEditLogStore.setState({ entries: [], floorSeq: 1 });
    store().hydrate(saved([entry("e4", "m1")]));
    expect(log("m3").id).toBe("e5");
  });

  it("keeps anything logged before the saved log arrived, after it", () => {
    log("now");
    store().hydrate(saved([entry("e1", "m1"), entry("e2", "m1")]));
    // The saved e1 clashes with this run's e1, which wins.
    expect(store().entries.map((e) => [e.id, e.step, e.fromEarlierRun ?? false])).toEqual([
      ["e2", "m1", true],
      ["e1", "now", false],
    ]);
    expect(log("next").id).toBe("e3");
  });

  it("trims the oldest reverted entries first, then the oldest", () => {
    const entries = [entry("e1", "a"), entry("e2", "a", true), entry("e3", "b"), entry("e4", "b", true), entry("e5", "c")];
    expect(trimEntries(entries, 3).map((e) => e.id)).toEqual(["e1", "e3", "e5"]);
    expect(trimEntries(entries, 2).map((e) => e.id)).toEqual(["e3", "e5"]);
    expect(trimEntries(entries, 10)).toBe(entries);
  });

  it("saves without the earlier-run flag, with backups only for requests still logged", () => {
    store().hydrate(saved([entry("e1", "m1")]));
    useEditLogStore.setState({ backups: { ...store().backups, "gone|resolve|Main": "Main (before VibeCut 7)" } });
    const out = savedEditLog();
    expect(out.entries[0].fromEarlierRun).toBeUndefined();
    expect(out.backups).toEqual({ "m1|resolve|Main": "Main (before VibeCut 1)" });
    expect(out.nextSeq).toBe(2);
  });

  it("checks a saved log read back from disk", () => {
    expect(parseSavedEditLog(null)).toBeNull();
    expect(parseSavedEditLog({ entries: "no" })).toBeNull();
    const parsed = parseSavedEditLog({
      entries: [entry("e1", "m1"), { id: "e2" }, { ...entry("e3", "m1"), host: "avid" }],
      backups: { a: "b", bad: 3 },
      restoredIds: { resolve: { x: "y" } },
      nextSeq: 7,
    });
    expect(parsed?.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(parsed?.backups).toEqual({ a: "b" });
    expect(parsed?.restoredIds).toEqual({ premiere: {}, resolve: { x: "y" } });
    expect(parsed?.nextSeq).toBe(7);
  });
});
