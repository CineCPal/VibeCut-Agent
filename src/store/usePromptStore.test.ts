import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_CHARS, NAME_PATTERN, PACK_14, STARTER_PROMPTS, addPack14, matchingPrompts, nameProblem, usePromptStore } from "./usePromptStore";

const store = () => usePromptStore.getState();

describe("saved prompts (Phase 8h)", () => {
  beforeEach(() => {
    usePromptStore.setState({ prompts: [] });
    store().restoreStarters();
  });

  it("starts with the starters", () => {
    expect(store().prompts.map((p) => p.name)).toEqual(STARTER_PROMPTS.map((p) => p.name));
  });

  it("checks names: a slug, and one prompt each", () => {
    expect(nameProblem("", store().prompts)).toBe("Give it a name");
    expect(nameProblem("Rough Cut", store().prompts)).toMatch(/lowercase letters/);
    expect(nameProblem("-x", store().prompts)).toMatch(/lowercase letters/);
    expect(nameProblem("x".repeat(33), store().prompts)).toMatch(/lowercase letters/);
    expect(nameProblem("rough-cut", store().prompts)).toBe("There's already a /rough-cut");
    const own = store().prompts.find((p) => p.name === "rough-cut")!;
    expect(nameProblem("rough-cut", store().prompts, own.id)).toBeNull();
  });

  it("adds, changes and removes prompts, refusing bad ones", () => {
    expect(store().add("titles", "  ")).toBe("Write the message it puts in the box");
    expect(store().add("titles", "Add a title card for each speaker.")).toBeNull();
    const titles = store().prompts.find((p) => p.name === "titles")!;
    expect(store().update(titles.id, "find-silences", "x")).toBe("There's already a /find-silences");
    expect(store().update(titles.id, "lower-thirds", "Lower thirds, please.")).toBeNull();
    expect(store().prompts.find((p) => p.id === titles.id)).toMatchObject({ name: "lower-thirds", body: "Lower thirds, please." });
    store().remove(titles.id);
    expect(store().prompts.some((p) => p.id === titles.id)).toBe(false);
  });

  it("restores deleted starters without touching the user's changes", () => {
    const rough = store().prompts.find((p) => p.name === "rough-cut")!;
    store().update(rough.id, "rough-cut", "My own rough cut.");
    store().remove(store().prompts.find((p) => p.name === "find-silences")!.id);
    store().restoreStarters();
    expect(store().prompts.filter((p) => p.name === "rough-cut")).toEqual([expect.objectContaining({ body: "My own rough cut." })]);
    expect(store().prompts.some((p) => p.name === "find-silences")).toBe(true);
  });

  it("lists names that start with the query first, then ones that contain it", () => {
    const names = matchingPrompts(store().prompts, "t").map((p) => p.name);
    expect(names[0]).toBe(names.find((n) => n.startsWith("t")) ?? names[0]);
    expect(matchingPrompts(store().prompts, "cut").map((p) => p.name)).toEqual(["rough-cut", "beat-cut", "social-cutdown"]);
    expect(matchingPrompts(store().prompts, "")).toHaveLength(STARTER_PROMPTS.length);
  });

  it("ships the Phase 14e pack: valid, unique names and bodies that fit (Phase 14e)", () => {
    const names = STARTER_PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of STARTER_PROMPTS) {
      expect(p.name).toMatch(NAME_PATTERN);
      expect(p.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
    expect(PACK_14.map((p) => p.name)).toEqual(["qc", "notes", "loudness-check", "describe-footage", "beat-markers", "beat-cut", "social-cutdown", "client-brief", "chapters", "whats-changed"]);
    expect(names.slice(-PACK_14.length)).toEqual(PACK_14.map((p) => p.name));
  });

  it("gives a store saved before the pack the new starters once, keeping the user's own (Phase 14e)", () => {
    const saved = { prompts: [{ id: "a", name: "rough-cut", body: "Mine." }, { id: "b", name: "qc", body: "My own QC." }] };
    const migrated = addPack14(saved, 1).prompts as { name: string; body: string }[];
    // A starter deleted before (find-silences) isn't brought back; a prompt the user already calls /qc stays theirs.
    expect(migrated.map((p) => p.name)).toEqual(["rough-cut", "qc", ...PACK_14.map((p) => p.name).filter((n) => n !== "qc")]);
    expect(migrated.find((p) => p.name === "qc")?.body).toBe("My own QC.");
    expect(addPack14({ prompts: migrated }, 2).prompts).toEqual(migrated);
    expect(addPack14(undefined, 1).prompts).toHaveLength(PACK_14.length);
  });
});
