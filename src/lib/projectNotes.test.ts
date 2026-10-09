import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));

import { matchingNotes, notesContext, withNote, withoutLine } from "./projectNotes";
import { executorsFor, runTool, type ToolContext } from "./agent/tools";
import { initialHosts, useNleStateStore } from "../store/useNleStateStore";
import { opensNotes } from "../hooks/useHotkeys";

describe("project notes text", () => {
  it("adds a line under its section, making sections in a fixed order", () => {
    let text = withNote("", "style", "No whip pans")!;
    expect(text).toBe("## Style\n- No whip pans\n");
    text = withNote(text, "brief", "60 s for Instagram")!;
    expect(text).toBe("## Brief\n- 60 s for Instagram\n\n## Style\n- No whip pans\n");
    text = withNote(text, "brief", "Due Friday")!;
    expect(text).toBe("## Brief\n- 60 s for Instagram\n- Due Friday\n\n## Style\n- No whip pans\n");
    text = withNote(text, "decisions", "Open on the oven")!;
    expect(text.endsWith("## Style\n- No whip pans\n\n## Decisions\n- Open on the oven\n")).toBe(true);
  });

  it("keeps the user's own headings and text, and doesn't add a line twice", () => {
    const mine = "Shot on FX3.\n\n## brief\n- Bakery film (2026-10-01)\n";
    expect(withNote(mine, "brief", "Bakery  FILM (2026-10-09)")).toBeNull();
    expect(withNote(mine, "brief", "Warm tone")).toBe("Shot on FX3.\n\n## brief\n- Bakery film (2026-10-01)\n- Warm tone\n");
  });

  it("finds lines by all their words and removes one, with a heading left empty", () => {
    const text = "## People\n- Dana is the owner\n- Sam does sound\n\n## Style\n- No whip pans\n";
    expect(matchingNotes(text, "dana OWNER")).toEqual([{ index: 1, line: "- Dana is the owner" }]);
    expect(matchingNotes(text, "is")).toHaveLength(1);
    expect(matchingNotes(text, "")).toEqual([]);
    expect(withoutLine(text, 5)).toBe("## People\n- Dana is the owner\n- Sam does sound\n");
    expect(withoutLine("## Style\n- Only one\n", 1)).toBe("");
  });

  it("puts the notes, or how to start them, in the snapshot", () => {
    expect(notesContext("Doc", " ")).toMatch(/^\[PROJECT NOTES for "Doc": none yet/);
    expect(notesContext("Doc", "## Brief\n- x\n")).toBe('[PROJECT NOTES for "Doc" (kept across chats; remember_note / forget_note change them)]\n## Brief\n- x\n[END PROJECT NOTES]');
  });

  it("opens on ⌘⇧N", () => {
    const mods = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(opensNotes({ ...mods, key: "N" })).toBe(true);
    expect(opensNotes({ ...mods, key: "n", shiftKey: false })).toBe(false);
  });
});

describe("remember_note and forget_note", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "x" };
  let stored = "";

  beforeEach(() => {
    stored = "";
    const hosts = initialHosts();
    hosts.resolve = { ...hosts.resolve, status: "connected", project: "Bakery" };
    useNleStateStore.setState({ hosts });
    core.invoke.mockReset();
    core.invoke.mockImplementation(async (cmd: string, args: { host: string; project: string; text?: string }) => {
      expect([args.host, args.project]).toEqual(["resolve", "Bakery"]);
      if (cmd === "project_notes_get") return stored;
      if (cmd === "project_notes_set") stored = args.text!;
    });
  });

  it("saves a dated line, once", async () => {
    const outcome = await runTool(executorsFor(context), "remember_note", { section: "people", text: "Dana is the owner" });
    expect(outcome.summary).toBe('Remembered for "Bakery" (People): Dana is the owner');
    expect(stored).toMatch(/^## People\n- Dana is the owner \(\d{4}-\d{2}-\d{2}\)\n$/);
    const again = await runTool(executorsFor(context), "remember_note", { section: "people", text: "dana is the OWNER" });
    expect(again.result).toEqual({ saved: false, reason: "That's already in the notes." });
  });

  it("refuses a bad section, a long line and no project", async () => {
    const error = async (args: Record<string, unknown>) => ((await runTool(executorsFor(context), "remember_note", args)).result as { error: string }).error;
    expect(await error({ section: "mood", text: "x" })).toMatch(/section must be one of/);
    expect(await error({ section: "style", text: "x".repeat(301) })).toMatch(/under 300/);
    useNleStateStore.setState((s) => ({ hosts: { ...s.hosts, resolve: { ...s.hosts.resolve, project: null } } }));
    expect(await error({ section: "style", text: "x" })).toMatch(/No project is open/);
  });

  it("forgets the one line that matches, or says which lines do", async () => {
    stored = "## People\n- Dana is the owner\n- Dana's sister Ana runs the till\n";
    const two = await runTool(executorsFor(context), "forget_note", { text: "dana" });
    expect((two.result as { error: string }).error).toMatch(/^2 lines match/);
    const one = await runTool(executorsFor(context), "forget_note", { text: "Dana owner" });
    expect(one.result).toEqual({ removed: "Dana is the owner" });
    expect(stored).toBe("## People\n- Dana's sister Ana runs the till\n");
  });
});
