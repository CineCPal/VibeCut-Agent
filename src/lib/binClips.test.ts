import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("./ipc", () => ipc);

import { groupByFolder, pickBin, resolveBin } from "./binClips";

const BINS = ["Proj", "Proj/Footage", "Proj/Footage/Drone", "Proj/Footage/Drone Old", "Proj/Audio", "Proj/Selects/Drone"];

describe("bins named by the agent", () => {
  it("takes an exact path first, then a bin's name, then the end of a path, then part of one", () => {
    expect(pickBin(BINS, "Proj/Footage/Drone")).toBe("Proj/Footage/Drone");
    expect(pickBin(BINS, "audio")).toBe("Proj/Audio");
    expect(pickBin(BINS, "footage/drone")).toBe("Proj/Footage/Drone");
    expect(pickBin(BINS, "drone old")).toBe("Proj/Footage/Drone Old");
    expect(pickBin(BINS, "Selec")).toBe("Proj/Selects/Drone");
  });

  it("names the candidates when a bin's name is ambiguous, and refuses a missing one", () => {
    expect(() => pickBin(BINS, "Drone")).toThrow('"Drone" matches 2 bins: "Proj/Footage/Drone", "Proj/Selects/Drone"');
    expect(() => pickBin(BINS, "Interviews")).toThrow("There's no bin");
    expect(() => pickBin(BINS, "  ")).toThrow("bin must name a bin");
  });
});

describe("a bin's files", () => {
  beforeEach(() => {
    ipc.nleCall.mockReset();
    ipc.nleCall.mockResolvedValue({
      bins: BINS.map((path) => ({ path, clips: 1 })),
      truncated: false,
      clips: [
        { id: "p1", name: "a", bin: "Proj/Footage", type: "Video + Audio", filePath: "/m/day1/a.mov", usage: 0, duration: 12 },
        { id: "p2", name: "b", bin: "Proj/Footage/Drone", type: "Video", filePath: "/m/day2/b.mov", usage: 0 },
        { id: "p3", name: "b again", bin: "Proj/Footage", type: "Video", filePath: "/m/day2/b.mov", usage: 0 },
        { id: "p4", name: "vo", bin: "Proj/Footage", type: "Audio", filePath: "/m/vo.wav", usage: 0 },
        { id: "p5", name: "Seq", bin: "Proj/Footage", type: "Video", usage: 0 },
        { id: "p6", name: "lost", bin: "Proj/Footage", type: "Video", filePath: "/m/lost.mov", offline: true, usage: 0 },
        { id: "p7", name: "fresh", bin: "Proj/Footage", type: "", filePath: "/m/day1/c.MP4", usage: 0 },
        { id: "p8", name: "other", bin: "Proj/Audio", type: "Video", filePath: "/m/x.mov", usage: 0 },
      ],
    });
  });

  it("lists the picture clips with a local file, sub-bins included, each file once", async () => {
    const bin = await resolveBin("premiere", "footage", "Seq 1");
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "read_media_pool", { timeline: "Seq 1" });
    expect(bin.binPath).toBe("Proj/Footage");
    expect(bin.clips.map((c) => c.filePath)).toEqual(["/m/day1/a.mov", "/m/day2/b.mov", "/m/day1/c.MP4"]);
    expect(bin.clips[0]).toEqual({ id: "p1", name: "a", filePath: "/m/day1/a.mov", duration: 12 });
    expect(bin.skipped).toEqual([
      { name: "Seq", reason: "no media file" },
      { name: "lost", reason: "offline" },
    ]);
    expect(bin.truncated).toBe(false);
  });

  it("groups files by folder in first-seen order", () => {
    expect(groupByFolder(["/m/day1/a.mov", "/m/day2/b.mov", "/m/day1/c.mov", "/top.mov"])).toEqual([
      { folder: "/m/day1", files: ["/m/day1/a.mov", "/m/day1/c.mov"] },
      { folder: "/m/day2", files: ["/m/day2/b.mov"] },
      { folder: "/", files: ["/top.mov"] },
    ]);
  });
});
