import { describe, expect, it } from "vitest";
import { connectionDetail, needsResync, panelAdvice } from "./nleStatus";
import { nleState } from "../test/nleFixtures";
import type { PremierePanelStatus } from "../types/nle";

const panel = (over: Partial<PremierePanelStatus> = {}): PremierePanelStatus => ({
  premiereInstalled: true,
  bundledVersion: "0.1.0",
  installedVersion: "0.1.0",
  installedPath: "/x",
  debugMode: true,
  running: true,
  ...over,
});

describe("nleStatus", () => {
  it("re-syncs after a new connection, a restart or a project switch only", () => {
    for (const reason of ["connected", "reconnected", "restarted", "project_changed"] as const) {
      expect(needsResync(nleState("premiere", { reason }))).toBe(true);
    }
    expect(needsResync(nleState("premiere", { reason: "timeline_changed" }))).toBe(false);
    expect(needsResync(nleState("premiere", { status: "disconnected", reason: "disconnected" }))).toBe(false);
  });

  it("describes a connection", () => {
    expect(connectionDetail(nleState("resolve"))).toBe("Doc · Main");
    expect(connectionDetail(nleState("resolve", { timeline: null }))).toBe("Doc");
    expect(connectionDetail(nleState("resolve", { project: null }))).toBe("No project open");
    expect(connectionDetail(nleState("resolve", { status: "disconnected", message: "Resolve isn't running" }))).toBe(
      "Resolve isn't running",
    );
  });

  it("says what to do next with the Premiere panel", () => {
    expect(panelAdvice(panel({ premiereInstalled: false }))).toBe("Premiere Pro isn't installed.");
    expect(panelAdvice(panel({ installedVersion: null }))).toMatch(/^Install the panel/);
    expect(panelAdvice(panel({ installedVersion: "0.0.9" }))).toMatch(/^Update the panel \(installed 0\.0\.9, this app has 0\.1\.0\)/);
    expect(panelAdvice(panel({ debugMode: false }))).toMatch(/PlayerDebugMode/);
    expect(panelAdvice(panel({ running: false }))).toMatch(/^Installed\. Start or restart/);
    expect(panelAdvice(panel())).toBeNull();
  });
});
