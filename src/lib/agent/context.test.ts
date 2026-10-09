import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { snapshotFor } from "./context";
import { forgetMediaFacts } from "./mediaInfo";
import { forgetTranscriptStatus } from "./awareness";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import type { HostTimeline } from "../../types/timeline";

const VIEW: HostTimeline = {
  project: "Bakery",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [{ type: "audio", index: 1, name: "", enabled: true, clips: [{ id: "a1", name: "A.wav", start: 0, end: 4, enabled: true, filePath: "/m/A.wav" }] }],
  markers: [],
  playhead: 2,
};

describe("the snapshot (Phase 13)", () => {
  beforeEach(() => {
    forgetMediaFacts();
    forgetTranscriptStatus();
    const hosts = initialHosts();
    hosts.resolve = { ...hosts.resolve, status: "connected", project: "Bakery" };
    useNleStateStore.setState({ hosts });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Bakery"), resolve: emptyConnection("Bakery") } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) =>
      command === "read_timeline" ? VIEW : { bins: [], clips: [], timelines: ["Main"], truncated: false, selection: { pool: [], timeline: [], underPlayhead: null } },
    );
    core.invoke.mockImplementation(async (cmd: string) => (cmd === "project_notes_get" ? "## Style\n- No whip pans\n" : null));
    jobs.runJob.mockResolvedValue({ status: "done", result: { info: { "/m/A.wav": { duration: 60, video: null, audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 } } } } });
  });

  it("starts with the project's notes and ends with the files, transcripts and B-roll scope", async () => {
    const text = await snapshotFor("resolve", "Main");
    expect(text.startsWith('[PROJECT NOTES for "Bakery"')).toBe(true);
    expect(text).toContain("- No whip pans\n[END PROJECT NOTES]\n\n[Resolve timeline \"Main\"");
    expect(text).toContain("playhead at 2.0s");
    expect(text).toContain('[SOURCES: 1 file(s) on the timeline]\n  "A.wav": pcm_s24le 2 ch 48 kHz · 1:00');
    expect(text).toContain('[TRANSCRIPTS: 0 of 1 heard file(s)] none yet: "A.wav"');
    expect(text.trimEnd().endsWith("[B-ROLL: find_broll searches the whole Spyglass archive]")).toBe(true);
  });

  it("still works when the notes can't be read", async () => {
    core.invoke.mockRejectedValue(new Error("disk gone"));
    const text = await snapshotFor("resolve", "Main");
    expect(text.startsWith('[Resolve timeline "Main"')).toBe(true);
  });
});
