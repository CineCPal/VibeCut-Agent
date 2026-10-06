import { describe, expect, it } from "vitest";
import type { TranscriptData } from "../types/transcript";
import {
  MAX_STORY_CATALOG_ENTRIES,
  MAX_STORY_SEGMENTS,
  briefWantsInterviewer,
  capCatalog,
  capTranscripts,
  payloadSegments,
  storySourceOf,
  totalSegmentCount,
  withoutInterviewer,
  type StoryTranscriptSource,
} from "./storyEditorContext";

// VibeCut's storyEditorContext tests, with gatherProjectTranscripts' cases moved onto storySourceOf.

const data = (lines: { start: number; end: number; text: string; speaker?: string }[], extra: Partial<TranscriptData> = {}): TranscriptData => ({
  segments: lines.map((l) => ({ start: l.start, end: l.end, text: l.text, speaker: l.speaker ?? "" })),
  speakers: [],
  speakerLabels: {},
  excludedSpeakers: [],
  ...extra,
});

describe("storySourceOf", () => {
  it("makes a source of one file's transcript, named after the file", () => {
    const source = storySourceOf(data([{ start: 0, end: 2, text: "Hi", speaker: "Speaker 1" }], { speakerLabels: { "Speaker 1": "Ana" } }), "/media/a.mov", "s1");
    expect(source).toEqual({ sourceId: "s1", mediaPath: "/media/a.mov", fileName: "a.mov", segments: [{ start: 0, end: 2, text: "Hi", speaker: "Ana" }] });
  });

  it("is null for a transcript with no lines", () => {
    expect(storySourceOf(data([]), "/media/a.mov", "s1")).toBeNull();
  });

  it("counts a speaker switched off in the transcriber as the interviewer", () => {
    const source = storySourceOf(data([{ start: 0, end: 1, text: "Why?", speaker: "Speaker 1" }], { excludedSpeakers: ["Speaker 1"] }), "/a", "s1")!;
    expect(source.segments[0]).toMatchObject({ speaker: "Interviewer", interviewer: true });
  });
});

describe("capTranscripts", () => {
  const source = (id: string, count: number): StoryTranscriptSource => ({
    sourceId: id,
    mediaPath: `/media/${id}.mov`,
    fileName: `${id}.mov`,
    segments: Array.from({ length: count }, (_, i) => ({ start: i, end: i + 1, text: `line ${i}`, speaker: "" })),
  });

  it("passes sources through unchanged when under the limit", () => {
    const sources = [source("a", 3), source("b", 2)];
    expect(capTranscripts(sources, 10)).toEqual({ sources, truncated: false });
    expect(totalSegmentCount(sources)).toBe(5);
  });

  it("trims every source proportionally when over the limit, keeping at least one line each", () => {
    const sources = [source("a", 100), source("b", 10)];
    const { sources: trimmed, truncated } = capTranscripts(sources, 55);
    expect(truncated).toBe(true);
    expect(totalSegmentCount(trimmed)).toBeLessThanOrEqual(55);
    expect(trimmed[0].segments.length).toBeGreaterThan(trimmed[1].segments.length);
    expect(trimmed[1].segments.length).toBeGreaterThanOrEqual(1);
  });

  it("defaults to MAX_STORY_SEGMENTS", () => {
    expect(capTranscripts([source("a", MAX_STORY_SEGMENTS + 50)]).truncated).toBe(true);
  });
});

describe("capCatalog", () => {
  it("passes entries through unchanged when under the limit", () => {
    const entries = [{ brollId: "a", path: "/a", durationSeconds: 1, caption: null, tags: [], technicalScore: null }];
    expect(capCatalog(entries, 5)).toEqual({ entries, truncated: false });
  });

  it("keeps captioned entries over uncaptioned ones when trimming", () => {
    const captioned = { brollId: "a", path: "/a", durationSeconds: 1, caption: "has one", tags: [], technicalScore: null };
    const uncaptioned = { brollId: "b", path: "/b", durationSeconds: 1, caption: null, tags: [], technicalScore: null };
    const { entries, truncated } = capCatalog([uncaptioned, captioned], 1);
    expect(truncated).toBe(true);
    expect(entries).toEqual([captioned]);
  });

  it("defaults to MAX_STORY_CATALOG_ENTRIES", () => {
    const entries = Array.from({ length: MAX_STORY_CATALOG_ENTRIES + 5 }, (_, i) => ({ brollId: `${i}`, path: `/${i}`, durationSeconds: 1, caption: null, tags: [], technicalScore: null }));
    expect(capCatalog(entries).truncated).toBe(true);
  });
});

describe("interviewer lines", () => {
  const interview = data(
    [
      { start: 0, end: 2, text: "What did you build?", speaker: "Speaker 1" },
      { start: 2, end: 9, text: "A boat.", speaker: "Speaker 2" },
    ],
    { speakerInfo: { "Speaker 1": { role: "interviewer" }, "Speaker 2": { name: "Ana" } } },
  );

  it("labels the interviewer for the model and marks their lines", () => {
    const source = storySourceOf(interview, "/media/a.mov", "a")!;
    expect(source.segments.map((s) => [s.speaker, s.interviewer])).toEqual([
      ["Interviewer", true],
      ["Ana", undefined],
    ]);
    expect(payloadSegments(source)[0]).toEqual({ start: 0, end: 2, text: "What did you build?", speaker: "Interviewer" });
    expect(withoutInterviewer([source])[0].segments.map((s) => s.text)).toEqual(["A boat."]);
  });

  it("drops a source with nothing but interviewer lines", () => {
    const only: StoryTranscriptSource = { sourceId: "q", mediaPath: "/q", fileName: "q", segments: [{ start: 0, end: 1, text: "?", speaker: "Interviewer", interviewer: true }] };
    expect(withoutInterviewer([only])).toEqual([]);
  });

  it("keeps the questions only when the brief asks for them", () => {
    expect(briefWantsInterviewer("Keep the questions so it reads like a Q&A")).toBe(true);
    expect(briefWantsInterviewer("include the interviewer's intro")).toBe(true);
    expect(briefWantsInterviewer("a 60s cut of her best answers")).toBe(false);
    expect(briefWantsInterviewer("what she says about the question of pricing")).toBe(false);
  });
});
