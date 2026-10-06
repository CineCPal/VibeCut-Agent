import { beforeEach, describe, expect, it } from "vitest";
import { etaSeconds, formatDuration, INITIAL_SESSION, useSidecarStore } from "./useSidecarStore";

const store = () => useSidecarStore.getState();
const job = () => store().jobs[0];

describe("useSidecarStore", () => {
  beforeEach(() => {
    useSidecarStore.setState({ session: INITIAL_SESSION, jobs: [] });
    store().addJob({ id: "j1", command: "health", label: "Health check" }, 1_000);
  });

  it("adds jobs newest first in the starting state", () => {
    store().addJob({ id: "j2", command: "health", label: "Again" }, 2_000);
    expect(store().jobs.map((j) => j.id)).toEqual(["j2", "j1"]);
    expect(job()).toMatchObject({ status: "starting", fraction: null, log: [] });
  });

  it("reduces progress events, clamping the fraction", () => {
    store().applyEvent("j1", { type: "progress", fraction: 0.25, phase: "scan", detail: "clip 1 of 4" });
    expect(job()).toMatchObject({ status: "running", fraction: 0.25, phase: "scan", detail: "clip 1 of 4" });
    store().applyEvent("j1", { type: "progress", fraction: 4 });
    expect(job()).toMatchObject({ fraction: 1, phase: "scan" });
    store().applyEvent("j1", { type: "progress", fraction: "bad" });
    expect(job().fraction).toBe(1);
  });

  it("keeps the last log lines, errors and results", () => {
    for (let i = 0; i < 60; i++) store().applyEvent("j1", { type: "log", line: `l${i}` });
    expect(job().log).toHaveLength(50);
    expect(job().log[0]).toBe("l10");
    store().applyEvent("j1", { type: "result", python: "3.14.0" });
    expect(job().result).toEqual({ python: "3.14.0" });
    store().applyEvent("j1", { type: "error", message: "bad" });
    expect(job().error).toBe("bad");
  });

  it("finishes as done, failed or cancelled", () => {
    store().applyExit({ jobId: "j1", code: 0, cancelled: false, message: null }, 5_000);
    expect(job()).toMatchObject({ status: "done", fraction: 1, endedAt: 5_000 });

    store().addJob({ id: "j2", command: "health", label: "x" });
    store().applyExit({ jobId: "j2", code: 1, cancelled: false, message: null });
    expect(job()).toMatchObject({ status: "failed", error: "The sidecar stopped (exit code 1)" });

    store().addJob({ id: "j3", command: "health", label: "x" });
    store().applyExit({ jobId: "j3", code: null, cancelled: true, message: null });
    expect(job().status).toBe("cancelled");
  });

  it("prefers the sidecar's own error over the exit message", () => {
    store().applyEvent("j1", { type: "error", message: "Request must be an object" });
    store().applyExit({ jobId: "j1", code: 2, cancelled: false, message: "stderr tail" });
    expect(job()).toMatchObject({ status: "failed", error: "Request must be an object" });
  });

  it("ignores events after a job ended and for unknown jobs", () => {
    store().applyExit({ jobId: "j1", code: 0, cancelled: false, message: null });
    store().applyEvent("j1", { type: "error", message: "late" });
    store().applyEvent("nope", { type: "error", message: "x" });
    expect(job()).toMatchObject({ status: "done", error: null });
  });

  it("marks cancelling, fails and clears finished jobs", () => {
    store().markCancelling("j1");
    expect(job().detail).toBe("Stopping…");
    store().addJob({ id: "j2", command: "health", label: "x" });
    store().fail("j2", "uv not found");
    expect(job()).toMatchObject({ status: "failed", error: "uv not found" });
    store().clearFinished();
    expect(store().jobs.map((j) => j.id)).toEqual(["j1"]);
  });

  it("estimates the time left from progress", () => {
    store().applyEvent("j1", { type: "progress", fraction: 0.01 });
    expect(etaSeconds(job(), 11_000)).toBeNull();
    store().applyEvent("j1", { type: "progress", fraction: 0.5 });
    expect(etaSeconds(job(), 11_000)).toBe(10);
  });

  it("formats durations", () => {
    expect(formatDuration(42.4)).toBe("42 s");
    expect(formatDuration(185)).toBe("3 min 05 s");
    expect(formatDuration(3720)).toBe("1 h 02 min");
  });
});
