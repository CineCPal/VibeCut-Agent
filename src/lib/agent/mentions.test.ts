import { beforeEach, describe, expect, it, vi } from "vitest";
import { nleState } from "../../test/nleFixtures";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { allMentions, keptMentions, loadMentionTimeline, matchingMentions, mentionBlock, mentionQuery, mentionTimeline } from "./mentions";
import { rememberTimelineView } from "./context";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { HostTimeline } from "../../types/timeline";

const view = (timeline: string): HostTimeline => ({
  project: "Doc",
  timeline,
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [{ id: "c1", name: "Interview A.mov", start: 0, end: 12.5, enabled: true }] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [{ id: "c2", name: "Music.wav", start: 0, end: 30, enabled: true }] },
  ],
  markers: [{ id: "m1", time: 4, name: "Hook", color: "Blue", note: "", duration: 0 }],
});

describe("mentions (Phase 11c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve", { timeline: "Main", timelines: ["Main", "Selects"] });
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useConnectionStore.setState({
      connections: {
        premiere: emptyConnection(),
        resolve: {
          ...emptyConnection("Doc"),
          pool: {
            bins: [],
            clips: [{ id: "pool-9", name: "Drone.mov", bin: "Master/B-roll", type: "Video", usage: 0 }],
            timelines: [],
            truncated: false,
            selection: { timeline: [], pool: [] } as never,
          },
          speakerInfo: { "/f/Interview A.mov": { "Speaker 1": { name: "Ria", role: "subject" } } },
        },
      },
    });
    useLibraryStore.setState({
      results: [{ key: "s1", shotId: 1, path: "/arch/sunset.mov", filename: "sunset.mov", start: 2, end: 6, caption: "Sun over the lake", tags: [], technical: null, energy: null, status: "ok" as never, keyframe: null }],
      pool: [],
    });
    rememberTimelineView("resolve", "Other", view("Other"));
  });

  it("finds the @word just before the caret", () => {
    expect(mentionQuery("Trim @Inter", 11)).toEqual({ query: "Inter", start: 5 });
    expect(mentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQuery("Trim @Inter view", 16)).toBeNull();
    expect(mentionQuery("mail me@home", 12)).toBeNull();
  });

  it("reads the open timeline once when the list opens, then lists every kind", async () => {
    ipc.nleCall.mockResolvedValue(view("Main"));
    expect(mentionTimeline()).toBeNull();
    expect(await loadMentionTimeline()).toBe(true);
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "read_timeline", { timeline: "Main" });
    expect(await loadMentionTimeline()).toBe(false);
    const all = allMentions();
    expect(all.map((m) => `${m.kind}:${m.label}`)).toEqual([
      "timeline:Main",
      "timeline:Selects",
      "clip:Interview A.mov",
      "clip:Music.wav",
      "marker:Hook",
      "media:Drone.mov",
      "speaker:Ria",
      "shot:sunset.mov (Sun over the lake)",
    ]);
    expect(all.find((m) => m.kind === "clip")).toEqual({ kind: "clip", label: "Interview A.mov", ref: "c1", detail: "V1 0.0s–12.5s" });
    expect(all.find((m) => m.kind === "speaker")).toMatchObject({ ref: "Speaker 1 in Interview A.mov", detail: "subject · /f/Interview A.mov" });
    expect(all.find((m) => m.kind === "shot")).toMatchObject({ ref: "/arch/sunset.mov", detail: "2.0s–6.0s" });
  });

  it("filters by the typed text, names that start with it first", () => {
    const all = [
      { kind: "clip" as const, label: "B-roll interview", ref: "c1" },
      { kind: "clip" as const, label: "Interview", ref: "c2" },
      { kind: "timeline" as const, label: "Main", ref: "Main" },
    ];
    expect(matchingMentions(all, "inter").map((m) => m.ref)).toEqual(["c2", "c1"]);
    expect(matchingMentions(all, "").map((m) => m.ref)).toEqual(["Main", "c1", "c2"]);
  });

  it("keeps the mentions still in the text and writes one exact line each", () => {
    const clip = { kind: "clip" as const, label: "Interview A.mov", ref: "c1", detail: "V1 0.0s–12.5s" };
    const marker = { kind: "marker" as const, label: "Hook", ref: "m1", detail: "at 4.0s" };
    expect(keptMentions("Cut @Interview A.mov at the hook", [clip, marker, clip])).toEqual([clip]);
    expect(mentionBlock([])).toBe("");
    expect(mentionBlock([clip, marker])).toBe(
      '[MENTIONED: what the user pointed at with @ in this message]\n- @Interview A.mov = clip id "c1" (V1 0.0s–12.5s)\n- @Hook = marker id "m1" (at 4.0s)',
    );
  });
});
