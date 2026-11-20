import { describe, expect, it } from "vitest";
import { systemInstruction } from "./prompt";

describe("the agent's Kanban instruction (Phase 23)", () => {
  it("plans multi-step requests on the board before any other tool, and leaves single steps off it", () => {
    for (const host of ["premiere", "resolve"] as const) {
      const prompt = systemInstruction(host);
      expect(prompt).toContain("when a request has more than one stage");
      expect(prompt).toContain("call kanban_plan_workflow\n  before any other tool");
      expect(prompt).toContain("A single-step request");
      expect(prompt).toContain("use its cards instead of planning new ones");
    }
  });
});
