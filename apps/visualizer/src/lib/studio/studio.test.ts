import { describe, expect, it } from "vitest";
import { SUBAGENT_TYPES } from "@vibecut/contracts";
import { pathLength, pointAt } from "./conduits";
import { MAX_TRANSIT_MS, MIN_TRANSIT_MS, transitMs } from "./packets";
import { STATIONS, stationKey } from "./stations";
import { CELL_W, fitSuite, METRICS, READABLE_SCALE, STUDIO_STYLES, suiteLayout, suiteWidth } from "./suite";
import { deskActivity } from "./activity";
import { env, spawn, tool } from "../../test/envelopes";
import { avatarPixels } from "../../components/studio/ProceduralPixelAvatar";
import { AVATAR_STATES } from "../../types/studio";

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the edit suite's floor plan", () => {
  it("gives every listed agent one desk, in its own role's room, for every style and column count", () => {
    expect(new Set(STATIONS.map((s) => s.key)).size).toBe(STATIONS.length);
    for (const style of STUDIO_STYLES)
    for (const columns of ([1, 2, 3, 4] as const).filter((c) => c <= METRICS[style].maxColumns)) {
      const plan = suiteLayout(columns, {}, style);
      expect(plan.style).toBe(style);
      expect(plan.rooms.map((r) => r.subagent).sort()).toEqual([...SUBAGENT_TYPES].sort());
      expect(plan.byKey.size).toBe(STATIONS.length);
      for (const room of plan.rooms) {
        expect(room.x).toBeGreaterThanOrEqual(0);
        expect(room.x + room.w).toBeLessThanOrEqual(plan.width);
        expect(room.y + room.h).toBeLessThanOrEqual(plan.height);
        for (const place of room.stations) {
          expect(place.station.subagent).toBe(room.subagent);
          // Each desk inside its room, below the room's name.
          expect(place.x).toBeGreaterThanOrEqual(room.x);
          expect(place.x + place.w).toBeLessThanOrEqual(room.x + room.w);
          expect(place.y).toBeGreaterThan(room.y);
          expect(place.y + place.h).toBeLessThanOrEqual(room.y + room.h);
        }
      }
      // Nothing overlaps: rooms with rooms, desks with desks.
      plan.rooms.forEach((a, i) => plan.rooms.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
      const desks = [...plan.byKey.values()];
      desks.forEach((a, i) => desks.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
    }
  });

  it("seats an agent the catalogue doesn't list at a desk of its own in its room", () => {
    const plan = suiteLayout(3, { AUDIO_ENGINEER: ["app.new_tool"] });
    const room = plan.rooms.find((r) => r.subagent === "AUDIO_ENGINEER");
    expect(room?.stations.map((s) => s.station.key)).toContain("app.new_tool");
    expect(plan.byKey.get("app.new_tool")?.station.title).toBe("new tool");
    expect(stationKey("worker.vlm.01")).toBe("worker.vlm");
    expect(stationKey("app.markers")).toBe("app.markers");
  });

  it("fits three columns in a wide pane and one readable, scrolling column in a narrow panel", () => {
    const wide = fitSuite(1400, 900);
    expect(wide?.columns).toBe(3);
    expect(wide?.width).toBeLessThanOrEqual(1400);
    const panel = fitSuite(340, 600);
    expect(panel?.columns).toBe(1);
    expect(panel!.scale).toBeGreaterThanOrEqual(READABLE_SCALE);
    // Taller than the panel: it scrolls rather than shrinking out of reading.
    expect(panel!.height).toBeGreaterThan(600);
    expect(fitSuite(0, 600)).toBeNull();
    expect(suiteWidth(1)).toBeGreaterThan(CELL_W);
  });

  it("packs the compact style tighter: more columns and a shorter plan in the same box", () => {
    const suite = fitSuite(1400, 900, {}, "suite")!;
    const compact = fitSuite(1400, 900, {}, "compact")!;
    expect(compact.columns).toBe(4);
    expect(compact.columns).toBeGreaterThan(suite.columns);
    expect(suiteLayout(4, {}, "compact").height).toBeLessThan(suiteLayout(3, {}, "suite").height / 2);
    // The panel gets more of the run on screen too.
    const panel = fitSuite(340, 600, {}, "compact")!;
    expect(panel.scale).toBeGreaterThanOrEqual(METRICS.compact.readableScale);
    expect(panel.height).toBeLessThan(fitSuite(340, 600, {}, "suite")!.height * 0.6);
  });

  it("counts each desk's events into slices of the last 20 s, oldest first, skipping heartbeats", () => {
    const now = 1_000_000;
    const logs = [
      env(1, spawn("a"), { agent: "worker.vlm.01", t: now - 30_000 }),
      env(2, tool("a"), { agent: "worker.vlm.01", t: now - 19_000 }),
      env(3, tool("a"), { agent: "worker.vlm.01", t: now - 100 }),
      env(4, tool("b"), { agent: "app.markers", t: now - 100 }),
    ];
    const activity = deskActivity(logs, now, 20_000, 4);
    expect(activity.get("worker.vlm")).toEqual([1, 0, 0, 1]);
    expect(activity.get("app.markers")).toEqual([0, 0, 0, 1]);
    expect(deskActivity([], now).size).toBe(0);
  });

  it("walks a packet's path end to end", () => {
    const path = [{ x: 0, y: 0 }, { x: 30, y: 40 }];
    expect(pathLength(path)).toBe(50);
    expect(pointAt(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(path, 0.5)).toEqual({ x: 15, y: 20 });
    expect(pointAt(path, 1)).toEqual({ x: 30, y: 40 });
  });
});

describe("the studio's packets and sprites", () => {
  it("times packets by the log of their size, clamped", () => {
    expect(transitMs(0)).toBe(MIN_TRANSIT_MS);
    expect(transitMs(1000)).toBe(350 + 60 * 3);
    expect(transitMs(1e12)).toBe(MAX_TRANSIT_MS);
  });

  it("draws a distinct 16x16 sprite for every role, state and bob", () => {
    const idle = avatarPixels("PACING_CUTTER", "IDLE", 0);
    expect(idle.every((p) => p.x >= 0 && p.x < 16 && p.y >= 0 && p.y < 16)).toBe(true);
    const bobbed = avatarPixels("PACING_CUTTER", "IDLE", 1);
    expect(Math.min(...bobbed.map((p) => p.y))).toBe(Math.min(...idle.map((p) => p.y)) + 1);
    const signatures = new Set(
      AVATAR_STATES.map((s) => JSON.stringify(avatarPixels("VISION_TAGGER", s, 0))),
    );
    expect(signatures.size).toBe(AVATAR_STATES.length);
    expect(JSON.stringify(avatarPixels("AUDIO_ENGINEER", "IDLE", 0))).not.toBe(JSON.stringify(avatarPixels("COLOR_GRADER", "IDLE", 0)));
  });
});
