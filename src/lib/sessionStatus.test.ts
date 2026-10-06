import { describe, expect, it } from "vitest";
import { sessionLabel } from "./sessionStatus";
import type { SessionStatus } from "../types/sidecar";

const session = (patch: Partial<SessionStatus>): SessionStatus => ({
  state: "starting",
  version: null,
  python: null,
  message: null,
  ...patch,
});

describe("sessionLabel", () => {
  it("labels each state", () => {
    expect(sessionLabel(session({ state: "starting" }))).toBe("Starting…");
    expect(sessionLabel(session({ state: "ready", python: "3.14.0" }))).toBe("Running · Python 3.14.0");
    expect(sessionLabel(session({ state: "ready" }))).toBe("Running");
    expect(sessionLabel(session({ state: "stopped", message: "x" }))).toBe("Stopped with an error");
    expect(sessionLabel(session({ state: "stopped" }))).toBe("Stopped");
  });
});
