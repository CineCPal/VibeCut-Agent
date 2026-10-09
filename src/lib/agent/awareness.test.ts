import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { forgetTranscriptStatus, heardFiles, libraryContext, transcriptsContext } from "./awareness";
import { factsLine, factsOf, forgetMediaFacts, learnFacts, sourcesContext, SOURCES_LIMIT } from "./mediaInfo";
import { editLogFor } from "./edits";
import { snapshotHeader } from "./snapshot";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { EditEntry } from "../../types/edits";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, file: string, over: Partial<HostClip> = {}): HostClip => ({
  id,
  name: file,
  start: 0,
  end: 2,
  enabled: true,
  filePath: `/m/${file}`,
  ...over,
});

const timeline = (over: Partial<HostTimeline> = {}): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", "A.mov"), clip("v2", "Broll.mov")] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", "A.mov"), clip("a2", "Muted.wav", { enabled: false })] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("a3", "Music.wav")] },
  ],
  markers: [],
  ...over,
});

const transcript = (speakers: string[], labels: Record<string, string> = {}) => ({
  segments: [{ start: 0, end: 1, text: "Hi", speaker: speakers[0] }],
  speakers,
  speakerLabels: labels,
  excludedSpeakers: [],
});

describe("the snapshot's first line (Phase 13a)", () => {
  it("says where the playhead and the marks are", () => {
    expect(snapshotHeader("resolve", timeline({ playhead: 72.24, inOut: { in: 30, out: 120 } })).split("\n")[0]).toBe(
      '[Resolve timeline "Main" in project "Doc", 25 fps, 10.0s long, starts at 00:00:00:00; playhead at 72.2s, In 30.0s – Out 120.0s marked]',
    );
    expect(snapshotHeader("resolve", timeline()).split("\n")[0]).not.toMatch(/playhead/);
  });

  it("gives the frame size when the editor says it (Phase 14d)", () => {
    expect(snapshotHeader("premiere", timeline({ width: 1080, height: 1920 })).split("\n")[0]).toMatch(/^\[Premiere sequence "Main" in project "Doc", 1080x1920, 25 fps, /);
  });
});

describe("[SOURCES]", () => {
  beforeEach(() => {
    forgetMediaFacts();
    jobs.runJob.mockReset();
  });

  const facts = {
    duration: 723,
    video: { codec: "h264", width: 3840, height: 2160, fps: 23.976 },
    audio: { codec: "aac", channels: 2, sampleRate: 48000 },
  };

  it("writes a file's format on one line", () => {
    expect(factsLine("/m/A.mov", facts)).toBe('"A.mov": h264 3840x2160 23.976 fps · aac 2 ch 48 kHz · 12:03');
    expect(factsLine("/m/B.wav", { duration: 3725, video: null, audio: { codec: "pcm_s24le", channels: 1, sampleRate: 44100 } })).toBe(
      '"B.wav": pcm_s24le 1 ch 44.1 kHz · 1:02:05',
    );
    expect(factsLine("/m/C.mov", undefined)).toBe('"C.mov": (format not read yet)');
  });

  it("reads each file once, and lists every file the timeline uses", async () => {
    jobs.runJob.mockImplementation(async (_cmd: string, _label: string, req: { paths: string[] }) => ({
      status: "done",
      result: { info: Object.fromEntries(req.paths.filter((p) => !p.endsWith("Music.wav")).map((p) => [p, facts])), failed: [{ path: "/m/Music.wav", message: "gone" }] },
    }));
    await learnFacts(["/m/A.mov", "/m/Music.wav"]);
    await learnFacts(["/m/A.mov", "/m/Music.wav"]);
    // Read once; the failed file waits a minute before it's tried again.
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-info");
    expect(factsOf("/m/A.mov")).toEqual(facts);
    const block = sourcesContext(timeline())!;
    expect(block.split("\n")[0]).toBe("[SOURCES: 4 file(s) on the timeline]");
    expect(block).toContain('"A.mov": h264');
    expect(block).toContain('"Music.wav": (format not read yet)');
  });

  it("doesn't hold up the snapshot for a slow read", async () => {
    let finish: (v: unknown) => void = () => undefined;
    jobs.runJob.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const started = Date.now();
    await learnFacts(["/m/Slow.mov"], 20);
    expect(Date.now() - started).toBeLessThan(500);
    expect(factsOf("/m/Slow.mov")).toBeUndefined();
    finish({ status: "done", result: { info: { "/m/Slow.mov": facts } } });
    await learnFacts(["/m/Slow.mov"], 20);
    expect(factsOf("/m/Slow.mov")).toEqual(facts);
  });

  it("counts the files past its limit", () => {
    const many = timeline({
      tracks: [{ type: "video", index: 1, name: "", enabled: true, clips: Array.from({ length: SOURCES_LIMIT + 3 }, (_, i) => clip(`v${i}`, `F${i}.mov`)) }],
    });
    expect(sourcesContext(many)).toContain("(3 more file(s))");
    expect(sourcesContext(timeline({ tracks: [] }))).toBeNull();
  });
});

describe("[TRANSCRIPTS] and [B-ROLL]", () => {
  beforeEach(() => {
    forgetTranscriptStatus();
    core.invoke.mockReset();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useLibraryStore.setState({ scopes: [] });
  });

  it("lists the heard files only: sound that's on", () => {
    expect(heardFiles(timeline())).toEqual(["/m/A.mov", "/m/Music.wav"]);
  });

  it("says which heard files are transcribed, and who speaks", async () => {
    core.invoke.mockImplementation(async (_cmd: string, { mediaPath }: { mediaPath: string }) =>
      mediaPath === "/m/A.mov" ? transcript(["S1", "S2"], { S1: "Dana" }) : null,
    );
    useConnectionStore.setState((s) => ({
      connections: { ...s.connections, resolve: { ...s.connections.resolve, speakerInfo: { "/m/A.mov": { S1: { role: "interviewer" }, S2: { name: "Sam", role: "subject" } } } } },
    }));
    expect(await transcriptsContext("resolve", timeline())).toBe(
      '[TRANSCRIPTS: 1 of 2 heard file(s)] "A.mov" (Dana, interviewer; Sam, subject) — none yet: "Music.wav" (transcribe_clips makes them)',
    );
    // A transcribed file is read once; one without is checked again next time.
    await transcriptsContext("resolve", timeline());
    expect(core.invoke.mock.calls.filter((c) => c[1].mediaPath === "/m/A.mov")).toHaveLength(1);
    expect(core.invoke.mock.calls.filter((c) => c[1].mediaPath === "/m/Music.wav")).toHaveLength(2);
    forgetTranscriptStatus(["/m/A.mov"]);
    await transcriptsContext("resolve", timeline());
    expect(core.invoke.mock.calls.filter((c) => c[1].mediaPath === "/m/A.mov")).toHaveLength(2);
  });

  it("says what find_broll searches", () => {
    expect(libraryContext()).toBe("[B-ROLL: find_broll searches the whole Spyglass archive]");
    useLibraryStore.setState({ scopes: ["/Volumes/Archive/Cities/", "/Volumes/Archive/Drone"] });
    expect(libraryContext()).toBe('[B-ROLL: find_broll searches the folder(s) ticked in the Library: "Cities", "Drone"]');
  });
});

describe("get_edit_log", () => {
  const entry = (id: string, step: string, over: Partial<EditEntry> = {}): EditEntry => ({
    id,
    step,
    stepText: `request ${step}`,
    at: Date.UTC(2026, 9, 9, 12, Number(id.slice(1))),
    host: "resolve",
    timeline: "Main",
    tool: "delete_clips",
    summary: `edit ${id}`,
    backup: "Main (before VibeCut 1)",
    changes: [],
    ...over,
  });

  it("groups every edit by its request, newest last", () => {
    const log = editLogFor([entry("e1", "s1"), entry("e2", "s1", { reverted: { at: 1, changedSince: 1, failed: 0, lost: [] } }), entry("e3", "s2"), entry("e4", "s3", { host: "premiere" })], { host: "resolve" });
    expect(log).toMatchObject({ total: 3, live: 2 });
    const requests = log.requests as { request: string; edits: Record<string, unknown>[] }[];
    expect(requests.map((r) => [r.request, r.edits.map((e) => e.editId)])).toEqual([
      ["request s1", ["e1", "e2"]],
      ["request s2", ["e3"]],
    ]);
    expect(requests[0].edits[1]).toMatchObject({ status: "reverted", revertLeft: 1, timeline: "Main" });
  });

  it("gives only the latest request with lastStep", () => {
    const log = editLogFor([entry("e1", "s1"), entry("e2", "s2"), entry("e3", "s2")], { lastStep: true });
    expect((log.requests as { edits: unknown[] }[])[0].edits).toHaveLength(2);
    expect(log.total).toBe(2);
  });
});
