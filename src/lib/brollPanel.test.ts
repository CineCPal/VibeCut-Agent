import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
const lib = vi.hoisted(() => ({
  openLibrary: vi.fn(),
  toggleFolder: vi.fn(),
  setScope: vi.fn(),
  clearScope: vi.fn(),
  searchLibrary: vi.fn(),
  browseMore: vi.fn(),
  changePool: vi.fn(),
  importShots: vi.fn(),
  previewShot: vi.fn(),
  placeShot: vi.fn(),
}));
vi.mock("./library", async (original) => ({ ...(await original<typeof import("./library")>()), ...lib }));

import { buildBrollFile, handleAction } from "./brollPanel";
import { useLibraryStore, type LibraryShot } from "../store/useLibraryStore";
import { initialHosts, useNleStateStore } from "../store/useNleStateStore";
import { nleState } from "../test/nleFixtures";

const shot = (key: string, over: Partial<LibraryShot> = {}): LibraryShot => ({
  key,
  shotId: Number(key.slice(1)),
  path: `/Volumes/Archive/${key}.mov`,
  filename: `${key}.mov`,
  start: 1,
  end: 4,
  caption: "a sunset",
  tags: [],
  technical: 81.6,
  energy: null,
  status: "ok",
  keyframe: null,
  ...over,
});

const FOLDER = { name: "Arts", path: "/Volumes/Archive/Arts", isRoot: true, shotCount: 9, hasChildren: true, online: true, topTags: [], dateRange: null };

describe("the Premiere B-roll panel's app side", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere", { timeline: "Main" }) } });
    useLibraryStore.setState({
      index: { path: "/i.sqlite", source: "environment", chosen: null },
      scopes: ["/Volumes/Archive/Arts"],
      expanded: ["/Volumes/Archive/Arts"],
      children: { "": [FOLDER], "/Volumes/Archive/Arts": [{ ...FOLDER, name: "Dance", path: "/Volumes/Archive/Arts/Dance", isRoot: false, hasChildren: false }] },
      mode: "search",
      query: "sunset",
      results: [shot("s1"), shot("s2", { status: "offline" }), shot("x", { shotId: null, key: "/a.mov#1.00-4.00" })],
      total: null,
      hasMore: false,
      busy: null,
      error: null,
      pool: [shot("s1")],
      notice: null,
      pending: [],
    });
  });

  it("publishes the Library as broll.json: folders in tree order, shots, pool, and drag paths for usable shots only", () => {
    const file = buildBrollFile(42);
    expect(file.publishedAt).toBe(42);
    expect(file.folders.map((f) => [f.name, f.depth, f.checked, f.expanded])).toEqual([
      ["Arts", 0, true, true],
      ["Dance", 1, false, false],
    ]);
    expect(file.scopeLabel).toBe("Arts");
    // A shot Spyglass gave no id can't be named in the panel's protocol, so it isn't listed.
    expect(file.shots.map((s) => [s.key, s.status, s.pooled ?? false, s.technical])).toEqual([
      ["s1", "ok", true, 82],
      ["s2", "offline", false, 82],
    ]);
    expect(file.paths).toEqual({ s1: "/Volumes/Archive/s1.mov" });
    expect(file.editor).toEqual({ connected: true, timeline: "Main", noEditor: null, noPlace: null });
  });

  it("says why Source, Import and Place wait when Premiere isn't connected", () => {
    useNleStateStore.setState({ hosts: initialHosts() });
    const { editor } = buildBrollFile();
    expect(editor.connected).toBe(false);
    expect(editor.noEditor).toContain("connection to Premiere");
    expect(editor.noPlace).toBe("Connect Premiere to place clips");
  });

  it("answers the panel's actions with the Library, in Premiere", async () => {
    await handleAction({ id: "a1", type: "broll_search", query: "sunset" });
    expect(lib.searchLibrary).toHaveBeenCalledWith("sunset");
    await handleAction({ id: "a2", type: "broll_source", key: "s1" });
    expect(lib.previewShot).toHaveBeenCalledWith("s1", "premiere");
    await handleAction({ id: "a3", type: "broll_place", key: "s1" });
    expect(lib.placeShot).toHaveBeenCalledWith("s1", "premiere");
    await handleAction({ id: "a4", type: "broll_import", keys: ["s1"] });
    expect(lib.importShots).toHaveBeenCalledWith(["s1"], "premiere");
    await handleAction({ id: "a5", type: "broll_pool", op: "up", keys: ["s1"] });
    expect(lib.changePool).toHaveBeenCalledWith("up", ["s1"]);
  });

  it("acts only on folders it listed", async () => {
    await handleAction({ id: "a1", type: "broll_scope", path: "/etc", checked: true });
    await handleAction({ id: "a2", type: "broll_expand", path: "/etc" });
    expect(lib.setScope).not.toHaveBeenCalled();
    expect(lib.toggleFolder).not.toHaveBeenCalled();
    await handleAction({ id: "a3", type: "broll_scope", path: "/Volumes/Archive/Arts/Dance", checked: true });
    expect(lib.setScope).toHaveBeenCalledWith("/Volumes/Archive/Arts/Dance", true);
  });

  it("names the action a notice answers, so the panel stops waiting", async () => {
    await handleAction({ id: "a9", type: "broll_source", key: "s1" });
    useLibraryStore.setState({ notice: { text: "s1.mov is in the Source monitor.", failed: false } });
    expect(buildBrollFile(7).notice).toEqual({ actionId: "a9", text: "s1.mov is in the Source monitor.", failed: false, at: 7 });
  });
});
