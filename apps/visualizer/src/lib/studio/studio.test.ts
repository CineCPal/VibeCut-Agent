import { describe, expect, it } from "vitest";
import { conduitPath, pathLength, pointAt, CONDUITS } from "./conduits";
import { MAX_TRANSIT_MS, MIN_TRANSIT_MS, transitMs } from "./packets";
import { BAYS, bayAt, STUDIO_HEIGHT, STUDIO_WIDTH } from "./bays";
import { avatarPixels } from "../../components/studio/ProceduralPixelAvatar";
import { AVATAR_STATES } from "../../types/studio";

describe("the studio's geometry", () => {
  it("keeps every bay on the studio grid and finds them by point", () => {
    for (const bay of BAYS) {
      expect(bay.x - bay.w / 2).toBeGreaterThanOrEqual(0);
      expect(bay.x + bay.w / 2).toBeLessThanOrEqual(STUDIO_WIDTH);
      expect(bay.y - bay.h / 2).toBeGreaterThanOrEqual(0);
      expect(bay.y + bay.h / 2).toBeLessThanOrEqual(STUDIO_HEIGHT);
      expect(bayAt(bay.x, bay.y)?.subagent).toBe(bay.subagent);
    }
    expect(bayAt(5, 5)).toBeNull();
  });

  it("chamfers conduit corners at 45° and walks them end to end", () => {
    for (const [a, b] of CONDUITS) {
      const path = conduitPath(a, b);
      for (let i = 1; i < path.length; i++) {
        const dx = Math.abs(path[i].x - path[i - 1].x);
        const dy = Math.abs(path[i].y - path[i - 1].y);
        // Each segment is horizontal, vertical, or a 45° cut.
        expect(dx === 0 || dy === 0 || Math.abs(dx - dy) < 1e-6).toBe(true);
      }
      const [start, end] = [pointAt(path, 0), pointAt(path, 1)];
      expect(start.x).toBeCloseTo(path[0].x, 6);
      expect(start.y).toBeCloseTo(path[0].y, 6);
      expect(end.x).toBeCloseTo(path[path.length - 1].x, 6);
      expect(end.y).toBeCloseTo(path[path.length - 1].y, 6);
      expect(pathLength(path)).toBeGreaterThan(0);
    }
  });

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
