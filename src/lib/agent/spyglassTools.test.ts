import { beforeEach, describe, expect, it, vi } from "vitest";

const spyglass = vi.hoisted(() => ({ browseSpyglass: vi.fn(), spyglassFolderChildren: vi.fn() }));
vi.mock("../spyglassIpc", () => spyglass);
const lib = vi.hoisted(() => ({ searchSpyglass: vi.fn(), showAgentResults: vi.fn() }));
vi.mock("../library", async (original) => ({ ...(await original<typeof import("../library")>()), ...lib }));

import { SPYGLASS_EXECUTORS } from "./spyglassTools";
import { systemInstruction } from "./prompt";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { SpyglassMatch } from "../../types/spyglass";

const match = (over: Partial<SpyglassMatch> = {}): SpyglassMatch => ({
  path: "/Volumes/Archive/a.mov",
  filename: "a.mov",
  start: 1.234,
  end: 5.678,
  score: 0.4567,
  visual: 0.3,
  caption: "a sunset",
  tags: ["sky"],
  technical: 77,
  tagMatch: true,
  transcriptMatch: false,
  shotId: 4,
  energy: null,
  recordedAt: "2026-05-01T10:00:00Z",
  status: "ok",
  ...over,
});

describe("the agent's Spyglass tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLibraryStore.setState({ scopes: ["/Volumes/Archive/2025-2026/Athletics"] });
    lib.searchSpyglass.mockResolvedValue({ matches: [match(), match({ shotId: 5, status: "offline" })], warnings: [] });
  });

  it("find_broll searches the Library's ticked folders and shows its matches there", async () => {
    const outcome = await SPYGLASS_EXECUTORS.find_broll({ query: " sunset ", topK: 99 });
    expect(lib.searchSpyglass).toHaveBeenCalledWith("sunset", ["/Volumes/Archive/2025-2026/Athletics"], 50);
    expect(lib.showAgentResults).toHaveBeenCalledWith("sunset", expect.any(Array));
    expect(outcome.summary).toBe(`Found 2 B-roll match(es) for "sunset" in Athletics (the B-roll Library's ticked folders) (1 offline or changed, so not usable now).`);
    expect((outcome.result as { matches: unknown[] }).matches[0]).toEqual({
      path: "/Volumes/Archive/a.mov",
      filename: "a.mov",
      start: 1.23,
      end: 5.68,
      score: 0.46,
      caption: "a sunset",
      tags: ["sky"],
      technical: 77,
      recorded: "2026-05-01",
      status: "ok",
    });
  });

  it("find_broll searches the folders the agent names instead, or the whole archive", async () => {
    await SPYGLASS_EXECUTORS.find_broll({ query: "crowd", spyglassFolders: [] });
    expect(lib.searchSpyglass).toHaveBeenCalledWith("crowd", [], 8);
    await expect(SPYGLASS_EXECUTORS.find_broll({ query: "  " })).rejects.toThrow("query must describe the shot to find");
  });

  it("lists folders and describes a page of shots", async () => {
    spyglass.spyglassFolderChildren.mockResolvedValue([{ name: "Arts", path: "/a/Arts", isRoot: false, shotCount: 9, hasChildren: false, online: false, topTags: [], dateRange: null }]);
    const listed = await SPYGLASS_EXECUTORS.list_spyglass_folders({ parentPath: "/a" });
    expect(listed.summary).toBe("Listed 1 Spyglass folder(s) in /a, 1 offline.");
    spyglass.browseSpyglass.mockResolvedValue({ summary: { clipCount: 1, shotCount: 3, technicalCount: 0, energyCount: 0, dateRange: null, topTags: [] }, shots: [] });
    const described = await SPYGLASS_EXECUTORS.describe_spyglass_folder({ folders: ["/a/Arts"], limit: 500 });
    expect(spyglass.browseSpyglass).toHaveBeenCalledWith(["/a/Arts"], 0, 200);
    expect(described.result).toMatchObject({ nextOffset: 0 });
  });

  it("tells the agent how the Library's scope works", () => {
    expect(systemInstruction("premiere")).toContain("folders the user ticked in the B-roll Library");
  });
});
