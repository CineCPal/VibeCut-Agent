import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ startSidecar: vi.fn(), cancelSidecar: vi.fn(), nleCall: vi.fn() }));
vi.mock("./ipc", () => ipc);
const spyglass = vi.hoisted(() => ({
  findSpyglassIndex: vi.fn(),
  spyglassFolderChildren: vi.fn(),
  resolveSpyglassScope: vi.fn(),
  browseSpyglass: vi.fn(),
  spyglassKeyframes: vi.fn(),
  startShotDrag: vi.fn(),
  prepareShotDrags: vi.fn().mockResolvedValue(undefined),
  keyframeUrl: (p: string) => `asset://${p}`,
}));
vi.mock("./spyglassIpc", () => spyglass);
const broll = vi.hoisted(() => ({ placeAtPlayhead: vi.fn(), placementTarget: vi.fn() }));
vi.mock("./broll", () => broll);

import {
  changePool,
  clearScope,
  DRIVE_RECHECK_MS,
  dragShot,
  importShots,
  missingDrives,
  openLibrary,
  placeShot,
  previewShot,
  recheckDrives,
  resetLibraryForTests,
  scopeLabel,
  searchLibrary,
  setScope,
  showAgentResults,
  toggleFolder,
} from "./library";
import { useLibraryStore, type LibraryShot } from "../store/useLibraryStore";
import { initialHosts, useNleStateStore } from "../store/useNleStateStore";
import { useSidecarStore } from "../store/useSidecarStore";
import { nleState } from "../test/nleFixtures";
import type { SpyglassBrowseShot, SpyglassMatch } from "../types/spyglass";

const SUMMARY = { clipCount: 2, shotCount: 3, technicalCount: 0, energyCount: 0, dateRange: null, topTags: [] };
const browseShot = (id: number, over: Partial<SpyglassBrowseShot> = {}): SpyglassBrowseShot => ({
  shotId: id,
  path: `/Volumes/Archive/clip${id}.mov`,
  filename: `clip${id}.mov`,
  start: 0,
  end: 5,
  caption: `shot ${id}`,
  tags: [],
  technical: 80,
  energy: null,
  recordedAt: null,
  transcript: null,
  keyframe: `/kf/${id}.jpg`,
  status: "ok",
  ...over,
});
const match = (id: number, over: Partial<SpyglassMatch> = {}): SpyglassMatch => ({
  path: `/Volumes/Archive/clip${id}.mov`,
  filename: `clip${id}.mov`,
  start: 2,
  end: 6,
  score: 0.5,
  visual: 0.3,
  caption: "players on a field",
  tags: ["field"],
  technical: 70,
  tagMatch: true,
  transcriptMatch: false,
  shotId: id,
  energy: 40,
  recordedAt: null,
  status: "ok",
  ...over,
});

const reset = () =>
  useLibraryStore.setState({
    index: undefined,
    scopes: [],
    expanded: [],
    children: {},
    mode: "browse",
    query: "",
    results: [],
    total: null,
    hasMore: false,
    busy: null,
    error: null,
    warnings: [],
    searchJobId: null,
    pool: [],
    notice: null,
    pending: [],
  });

/** Finishes the search job the way the sidecar does: its result, then the process exiting. */
function finishSearch(matches: SpyglassMatch[]) {
  const job = useSidecarStore.getState().jobs.at(-1)!;
  useSidecarStore.getState().applyEvent(job.id, { type: "result", indexPath: "/i", indexed: 2, warnings: [], matches: [{ id: "q", text: "x", results: matches }], cancelled: false });
  useSidecarStore.getState().applyExit({ jobId: job.id, code: 0, cancelled: false, message: null });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const connect = (host: "premiere" | "resolve") => useNleStateStore.setState({ hosts: { ...initialHosts(), [host]: nleState(host) } });

describe("the B-roll Library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetLibraryForTests();
    reset();
    useSidecarStore.setState({ jobs: [] });
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    spyglass.findSpyglassIndex.mockResolvedValue({ path: "/suite/spyglass_index.sqlite", source: "environment", chosen: null });
    spyglass.spyglassFolderChildren.mockResolvedValue([{ name: "2025-2026", path: "/Volumes/Archive/2025-2026", isRoot: true, shotCount: 3, hasChildren: true, online: true, topTags: [], dateRange: null }]);
    spyglass.browseSpyglass.mockResolvedValue({ summary: SUMMARY, shots: [browseShot(1), browseShot(2)] });
    spyglass.resolveSpyglassScope.mockResolvedValue({ clipIds: [11, 12], summary: SUMMARY });
    spyglass.spyglassKeyframes.mockResolvedValue([{ shotId: 7, path: "/kf/7.jpg" }]);
    ipc.startSidecar.mockResolvedValue(undefined);
  });

  it("names its scope", () => {
    expect(scopeLabel([])).toBe("the whole archive");
    expect(scopeLabel(["/Volumes/Archive/2025-2026/Athletics"])).toBe("Athletics");
    expect(scopeLabel(["/a", "/b"])).toBe("2 folders");
  });

  it("opens on the index's roots and the scope's first page, once", async () => {
    await openLibrary();
    await openLibrary();
    const s = useLibraryStore.getState();
    expect(s.index?.path).toBe("/suite/spyglass_index.sqlite");
    expect(s.children[""]).toHaveLength(1);
    expect(s.results.map((r) => r.key)).toEqual(["s1", "s2"]);
    expect(s.total).toBe(3);
    expect(s.hasMore).toBe(true);
    expect(spyglass.browseSpyglass).toHaveBeenCalledTimes(1);
    // The page's shots are got ready to drag in the background.
    expect(spyglass.prepareShotDrags).toHaveBeenCalledWith([1, 2]);
  });

  describe("drives attached or ejected after it opened", () => {
    const root = (online: boolean) => ({ name: "2025-2026", path: "/Volumes/Archive", isRoot: true, shotCount: 3, hasChildren: true, online, topTags: [], dateRange: null });
    const sub = (online: boolean) => ({ ...root(online), name: "Athletics", path: "/Volumes/Archive/Athletics", isRoot: false });

    it("shows a drive that was attached, and reads the page again for its shots' status", async () => {
      spyglass.spyglassFolderChildren.mockResolvedValue([root(false)]);
      spyglass.browseSpyglass.mockResolvedValue({ summary: SUMMARY, shots: [browseShot(1, { status: "offline" })] });
      await openLibrary();
      spyglass.spyglassFolderChildren.mockResolvedValue([root(true)]);
      spyglass.browseSpyglass.mockResolvedValue({ summary: SUMMARY, shots: [browseShot(1)] });
      await recheckDrives();
      const s = useLibraryStore.getState();
      expect(s.children[""][0].online).toBe(true);
      expect(s.results[0].status).toBe("ok");
      expect(spyglass.browseSpyglass).toHaveBeenCalledTimes(2);
    });

    it("changes nothing when no drive came or went", async () => {
      spyglass.spyglassFolderChildren.mockResolvedValue([root(true)]);
      await openLibrary();
      const before = useLibraryStore.getState().children;
      await recheckDrives();
      expect(useLibraryStore.getState().children).toBe(before);
      expect(spyglass.browseSpyglass).toHaveBeenCalledTimes(1);
    });

    it("rechecks opened subfolders too, and doesn't re-run a search", async () => {
      spyglass.spyglassFolderChildren.mockImplementation(async (parent?: string) => (parent ? [sub(true)] : [root(true)]));
      await openLibrary();
      await toggleFolder("/Volumes/Archive");
      useLibraryStore.setState({ mode: "search", query: "crowd" });
      spyglass.spyglassFolderChildren.mockImplementation(async (parent?: string) => (parent ? [sub(false)] : [root(false)]));
      await recheckDrives();
      const s = useLibraryStore.getState();
      expect(s.children["/Volumes/Archive"][0].online).toBe(false);
      expect(s.children[""][0].online).toBe(false);
      expect(spyglass.browseSpyglass).toHaveBeenCalledTimes(1);
      expect(spyglass.resolveSpyglassScope).not.toHaveBeenCalled();
    });

    it("looks every few seconds and when the window comes back", async () => {
      spyglass.spyglassFolderChildren.mockResolvedValue([root(true)]);
      vi.useFakeTimers();
      try {
        await openLibrary();
        spyglass.spyglassFolderChildren.mockClear();
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(spyglass.spyglassFolderChildren).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(DRIVE_RECHECK_MS);
        expect(spyglass.spyglassFolderChildren).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("says there's nothing to browse without an index", async () => {
    spyglass.findSpyglassIndex.mockResolvedValue(null);
    await openLibrary();
    expect(useLibraryStore.getState().index).toBeNull();
    expect(spyglass.browseSpyglass).not.toHaveBeenCalled();
  });

  it("browses the ticked folders, and the whole archive again", async () => {
    await setScope("/Volumes/Archive/2025-2026", true);
    expect(useLibraryStore.getState().scopes).toEqual(["/Volumes/Archive/2025-2026"]);
    expect(spyglass.browseSpyglass).toHaveBeenLastCalledWith(["/Volumes/Archive/2025-2026"], 0, 60);
    await clearScope();
    expect(spyglass.browseSpyglass).toHaveBeenLastCalledWith([], 0, 60);
  });

  it("searches the scope's clips with Spyglass's ranking and shows the matches with keyframes", async () => {
    useLibraryStore.setState({ scopes: ["/Volumes/Archive/2025-2026"] });
    const searching = searchLibrary(" players on a field ");
    await tick();
    expect(spyglass.resolveSpyglassScope).toHaveBeenCalledWith(["/Volumes/Archive/2025-2026"]);
    expect(ipc.startSidecar).toHaveBeenCalledWith(expect.any(String), "broll-spyglass", { clipIds: [11, 12], queries: [{ id: "q", text: "players on a field" }], topK: 40 });
    expect(useLibraryStore.getState().busy).toContain("Searching 2025-2026");
    finishSearch([match(7), match(8, { status: "offline" })]);
    await searching;
    await tick();
    const s = useLibraryStore.getState();
    expect(s.mode).toBe("search");
    expect(s.results.map((r) => [r.key, r.status, r.keyframe])).toEqual([
      ["s7", "ok", "/kf/7.jpg"],
      ["s8", "offline", null],
    ]);
    expect(s.busy).toBeNull();
  });

  it("explains an empty scope instead of searching it", async () => {
    spyglass.resolveSpyglassScope.mockResolvedValue({ clipIds: [], summary: SUMMARY });
    await searchLibrary("anything");
    expect(useLibraryStore.getState().error).toBe("Spyglass has no clips in the whole archive");
    expect(ipc.startSidecar).not.toHaveBeenCalled();
  });

  it("shows the agent's matches", () => {
    showAgentResults("sunset", [match(3)]);
    expect(useLibraryStore.getState()).toMatchObject({ mode: "agent", query: "sunset" });
    expect(useLibraryStore.getState().results[0].key).toBe("s3");
  });

  it("pools, reorders and clears shots", async () => {
    await openLibrary();
    changePool("add", ["s1", "s2"]);
    changePool("add", ["s1"]);
    expect(useLibraryStore.getState().pool.map((p) => p.key)).toEqual(["s1", "s2"]);
    changePool("down", ["s1"]);
    expect(useLibraryStore.getState().pool.map((p) => p.key)).toEqual(["s2", "s1"]);
    changePool("remove", ["s2"]);
    expect(useLibraryStore.getState().pool.map((p) => p.key)).toEqual(["s1"]);
    changePool("clear", []);
    expect(useLibraryStore.getState().pool).toEqual([]);
  });

  describe("with an editor", () => {
    const shots: LibraryShot[] = [
      { key: "s1", shotId: 1, path: "/Volumes/Archive/a.mov", filename: "a.mov", start: 2, end: 6, caption: null, tags: [], technical: null, energy: null, status: "ok", keyframe: null },
      { key: "s2", shotId: 2, path: "/Volumes/Archive/b.mov", filename: "b.mov", start: 0, end: 3, caption: null, tags: [], technical: null, energy: null, status: "offline", keyframe: null },
    ];
    beforeEach(() => useLibraryStore.setState({ results: shots }));

    it("needs a connected editor for Source and Import", async () => {
      await importShots(["s1"]);
      expect(useLibraryStore.getState().notice).toEqual({ text: "Connect Premiere Pro or DaVinci Resolve first", failed: true });
      expect(ipc.nleCall).not.toHaveBeenCalled();
    });

    it("imports the usable shots' files into the B-roll bin", async () => {
      connect("premiere");
      ipc.nleCall.mockResolvedValue({ bin: "VibeCut B-roll", imported: [{}], reused: [] });
      await importShots(["s1", "s2"]);
      expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "import_media", { paths: ["/Volumes/Archive/a.mov"], bin: "VibeCut B-roll" });
      expect(useLibraryStore.getState().notice).toEqual({ text: 'Imported 1 file(s) into "VibeCut B-roll" in Premiere.', failed: false });
      expect(useLibraryStore.getState().pending).toEqual([]);
    });

    it("refuses an offline shot without calling the editor", async () => {
      connect("resolve");
      await previewShot("s2");
      expect(useLibraryStore.getState().notice?.failed).toBe(true);
      expect(ipc.nleCall).not.toHaveBeenCalled();
    });

    it("previews in Premiere's Source monitor and in Resolve's viewer (via the bin)", async () => {
      connect("premiere");
      ipc.nleCall.mockResolvedValue({ marked: true, atIn: true, imported: false });
      let seen: string | undefined;
      ipc.nleCall.mockImplementationOnce(async () => {
        seen = useLibraryStore.getState().notice?.text;
        return { marked: true, atIn: true, imported: false };
      });
      await previewShot("s1");
      expect(seen).toBe("Opening a.mov in the Source monitor…");
      expect(ipc.nleCall).toHaveBeenLastCalledWith("premiere", "source_preview", { path: "/Volumes/Archive/a.mov", inSeconds: 2, outSeconds: 6 });
      expect(useLibraryStore.getState().notice?.text).toBe("a.mov is in the Source monitor, In and Out marked.");

      connect("resolve");
      ipc.nleCall.mockResolvedValue({ marked: true, atIn: false, imported: true, page: "media" });
      await previewShot("s1");
      expect(ipc.nleCall).toHaveBeenLastCalledWith("resolve", "source_preview", { path: "/Volumes/Archive/a.mov", inSeconds: 2, outSeconds: 6, bin: "VibeCut B-roll" });
      expect(useLibraryStore.getState().notice?.text).toContain("Open the Edit page");
    });

    it("places the picture only, as a revertible request", async () => {
      broll.placeAtPlayhead.mockResolvedValue("Added 1 clip to the sequence");
      await placeShot("s1");
      expect(broll.placeAtPlayhead).toHaveBeenCalledWith({ path: "/Volumes/Archive/a.mov", filename: "a.mov", start: 2, end: 6 }, { sound: false });
      expect(useLibraryStore.getState().notice).toEqual({ text: "Added 1 clip to the sequence", failed: false });
    });

    it("names the drive to attach when an offline shot is dragged or previewed", async () => {
      connect("premiere");
      useLibraryStore.setState({ results: [{ ...shots[1], path: "/Volumes/2026 Main Drive - Blair/b.mov" }] });
      await dragShot(useLibraryStore.getState().results[0]);
      expect(spyglass.startShotDrag).not.toHaveBeenCalled();
      expect(useLibraryStore.getState().notice?.text).toBe('b.mov: Its drive "2026 Main Drive - Blair" isn\'t attached. Attach it to drag it into the editor.');
      await previewShot("s2");
      expect(ipc.nleCall).not.toHaveBeenCalled();
      expect(useLibraryStore.getState().notice?.text).toContain('Its drive "2026 Main Drive - Blair" isn\'t attached');
      expect(missingDrives(useLibraryStore.getState().results)).toEqual(["2026 Main Drive - Blair"]);
    });

    it("drags by shot id, and shows why a drag couldn't start", async () => {
      spyglass.startShotDrag.mockResolvedValueOnce(undefined).mockRejectedValueOnce("a.mov isn't reachable (is its drive attached?)");
      await dragShot(shots[0]);
      expect(spyglass.startShotDrag).toHaveBeenCalledWith(1);
      expect(useLibraryStore.getState().notice).toBeNull();
      await dragShot(shots[0]);
      expect(useLibraryStore.getState().notice).toEqual({ text: "a.mov isn't reachable (is its drive attached?)", failed: true });
    });
  });
});
