import { describe, expect, it } from "vitest";
import type { Clip } from "../types/timeline";
import type { TranscriptData } from "../types/transcript";
import { laneLines, lineAt, lineRange, packRows, rangesOfLines, searchLines, speakerCutRanges, type LaneLine } from "./transcriptLane";

const transcript = (extra: Partial<TranscriptData> = {}): TranscriptData => ({
  segments: [
    { start: 0, end: 4, text: "Welcome to the show", speaker: "Speaker 0" },
    { start: 4, end: 9, text: "Thanks for having me", speaker: "Speaker 1" },
    { start: 9, end: 12, text: "Let us talk about the ocean", speaker: "Speaker 0" },
  ],
  speakers: ["Speaker 0", "Speaker 1"],
  speakerLabels: {},
  excludedSpeakers: [],
  ...extra,
});

const clip = (id: string, startTime: number, sourceIn: number, sourceOut: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  mediaAssetId: "a",
  trackId: "t",
  startTime,
  duration: sourceOut - sourceIn,
  sourceIn,
  sourceOut,
  name: id,
  ...extra,
});

const map = (...clips: Clip[]) => Object.fromEntries(clips.map((c) => [c.id, c]));

describe("laneLines", () => {
  it("shows a synced camera clip's lines once, not again for its linked recording", () => {
    const base = { createdAt: "", fileName: "f", filePath: "/f", durationSeconds: 60 };
    const assetsById = {
      a: { ...base, id: "a", type: "video" as const, syncedAudio: [{ assetId: "rec", offset: -100, method: "waveform" as const }] },
      rec: { ...base, id: "rec", type: "audio" as const, durationSeconds: 600 },
    };
    const picture = clip("v", 0, 0, 12, { linkId: "L" });
    const recording = clip("r", 0, 100, 112, { linkId: "L", mediaAssetId: "rec" });
    const recTranscript = transcript({ segments: transcript().segments.map((s) => ({ ...s, start: s.start + 100, end: s.end + 100 })) });
    // The camera's transcript is the recording's, shifted (what transcriptFor hands the lane).
    const transcripts = { a: transcript(), rec: recTranscript };
    expect(laneLines(map(picture, recording), transcripts, assetsById)).toHaveLength(3);
    // Unlinked, or without the media map, the recording shows its own lines too.
    expect(laneLines(map(picture, recording), transcripts)).toHaveLength(6);
    expect(laneLines(map(picture, { ...recording, linkId: undefined }), transcripts, assetsById)).toHaveLength(6);
  });

  it("places every line at its source time when the clip starts at 0 and is untrimmed", () => {
    const lines = laneLines(map(clip("c", 0, 0, 12)), { a: transcript() });
    expect(lines.map((l) => [l.start, l.end, l.text, l.partial])).toEqual([
      [0, 4, "Welcome to the show", false],
      [4, 9, "Thanks for having me", false],
      [9, 12, "Let us talk about the ocean", false],
    ]);
  });

  it("maps source time through where the clip sits and how it is trimmed, clipping lines at the edges", () => {
    // Source 2..10 placed at timeline 20: the first line loses its start, the second is whole, the third loses its end.
    const lines = laneLines(map(clip("c", 20, 2, 10)), { a: transcript() });
    expect(lines.map((l) => [l.start, l.end, l.partial])).toEqual([
      [20, 22, true],
      [22, 27, false],
      [27, 28, true],
    ]);
  });

  it("drops lines with almost nothing left on the timeline", () => {
    expect(laneLines(map(clip("c", 0, 3.95, 12)), { a: transcript() }).map((l) => l.text)).toEqual(["Thanks for having me", "Let us talk about the ocean"]);
  });

  it("shows a line once for a video clip and its linked audio clip", () => {
    const lines = laneLines(map(clip("v", 5, 0, 12, { linkId: "l" }), clip("s", 5, 0, 12, { linkId: "l", trackId: "audio" })), { a: transcript() });
    expect(lines).toHaveLength(3);
  });

  it("shows a line twice when the file is used in two places, and keeps the halves of a split clip apart", () => {
    const twice = laneLines(map(clip("x", 0, 0, 4), clip("y", 30, 0, 4)), { a: transcript() });
    expect(twice.map((l) => l.start)).toEqual([0, 30]);

    const split = laneLines(map(clip("l", 0, 0, 6), clip("r", 6, 6, 12)), { a: transcript() });
    expect(split.map((l) => [l.start, l.end, l.partial])).toEqual([
      [0, 4, false],
      [4, 6, true],
      [6, 9, true],
      [9, 12, false],
    ]);
  });

  it("uses the transcriber's speaker labels and keeps excluded speakers as guessed interviewers", () => {
    const lines = laneLines(map(clip("c", 0, 0, 12)), { a: transcript({ speakerLabels: { "Speaker 0": "Ana" }, excludedSpeakers: ["Speaker 1"] }) });
    expect(lines.map((l) => [l.speaker, l.speakerId, l.role, l.roleInferred])).toEqual([
      ["Ana", "Speaker 0", undefined, undefined],
      ["Speaker 1", "Speaker 1", "interviewer", true],
      ["Ana", "Speaker 0", undefined, undefined],
    ]);
  });

  it("prefers VibeCut's speaker names and roles over the transcriber's", () => {
    const data = transcript({
      speakerLabels: { "Speaker 0": "Host" },
      excludedSpeakers: ["Speaker 1"],
      speakerInfo: { "Speaker 0": { name: "Ben", role: "interviewer" }, "Speaker 1": { name: "Ana", role: "subject" } },
    });
    const lines = laneLines(map(clip("c", 0, 0, 12)), { a: data });
    expect(lines.map((l) => [l.speaker, l.role, l.roleInferred])).toEqual([
      ["Ben", "interviewer", false],
      ["Ana", "subject", false],
      ["Ben", "interviewer", false],
    ]);
  });

  it("ignores clips whose media has no transcript", () => {
    expect(laneLines(map(clip("c", 0, 0, 12)), {})).toEqual([]);
    expect(laneLines(map(clip("c", 0, 0, 12)), { a: undefined })).toEqual([]);
  });

  it("gives ids that change when the line moves", () => {
    const before = laneLines(map(clip("c", 0, 0, 12)), { a: transcript() })[0].id;
    const after = laneLines(map(clip("c", 3, 0, 12)), { a: transcript() })[0].id;
    expect(before).not.toBe(after);
  });
});

describe("packRows", () => {
  it("keeps lines in one row while they do not overlap and starts a new row when they do", () => {
    const line = (start: number, end: number) => ({ id: `${start}`, assetId: "a", start, end, text: "", speaker: "", speakerId: "", partial: false });
    expect(packRows([line(0, 2), line(2, 4), line(3, 6), line(4, 5), line(6, 7)])).toEqual([0, 0, 1, 0, 0]);
  });
});

describe("finding lines", () => {
  const lines = laneLines(map(clip("c", 0, 0, 12)), { a: transcript() });

  it("lineAt returns the line being spoken, with the start inclusive and the end exclusive", () => {
    expect(lineAt(lines, 0)?.text).toBe("Welcome to the show");
    expect(lineAt(lines, 3.99)?.text).toBe("Welcome to the show");
    expect(lineAt(lines, 4)?.text).toBe("Thanks for having me");
    expect(lineAt(lines, 12)).toBeNull();
    expect(lineAt([], 1)).toBeNull();
  });

  it("searchLines matches every word, ignoring case, and nothing for an empty query", () => {
    expect(searchLines(lines, "OCEAN").map((l) => l.text)).toEqual(["Let us talk about the ocean"]);
    expect(searchLines(lines, "the ocean").map((l) => l.text)).toEqual(["Let us talk about the ocean"]);
    expect(searchLines(lines, "the")).toHaveLength(2);
    expect(searchLines(lines, "   ")).toEqual([]);
    expect(searchLines(lines, "ocean mountain")).toEqual([]);
  });

  it("lineRange spans from the anchor to the target in either direction", () => {
    const [a, b, c] = lines.map((l) => l.id);
    expect(lineRange(lines, a, c)).toEqual([a, b, c]);
    expect(lineRange(lines, c, b)).toEqual([b, c]);
    expect(lineRange(lines, null, b)).toEqual([b]);
    expect(lineRange(lines, "gone", b)).toEqual([b]);
    expect(lineRange(lines, a, "missing")).toEqual([]);
  });

  it("rangesOfLines gives the time range of each chosen line", () => {
    expect(rangesOfLines(lines, [lines[0].id, lines[2].id])).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 12 },
    ]);
  });
});

describe("laneLines — word timings", () => {
  const withWords = transcript({
    segments: [
      {
        start: 0,
        end: 4,
        text: "Um welcome to the show",
        speaker: "Speaker 0",
        words: [
          { start: 0, end: 0.5, text: "Um" },
          { start: 0.6, end: 1.2, text: "welcome" },
          { start: 1.3, end: 1.6, text: "to" },
          { start: 1.7, end: 2.0, text: "the" },
          { start: 2.1, end: 3.9, text: "show" },
        ],
      },
    ],
  });

  it("maps words to timeline time through the clip", () => {
    const [line] = laneLines(map(clip("c", 10, 0, 4)), { a: withWords });
    expect(line.words?.map((w) => [w.start, w.end, w.text])).toEqual([
      [10, 10.5, "Um"],
      [10.6, 11.2, "welcome"],
      [11.3, 11.6, "to"],
      [11.7, 12, "the"],
      [12.1, 13.9, "show"],
    ]);
  });

  it("keeps only words whose middle is on the clip, clamped to its edge", () => {
    // The clip starts at source 1.0, mid-way through "welcome" (0.6-1.2, middle 0.9): it is left out.
    const [line] = laneLines(map(clip("c", 0, 1, 2.05)), { a: withWords });
    expect(line.words?.map((w) => w.text)).toEqual(["to", "the"]);
    expect(line.words?.[1].end).toBeCloseTo(1); // "the" ends at source 2.0 = timeline 1.0
  });

  it("leaves words out entirely for a line that has none", () => {
    const [line] = laneLines(map(clip("c", 0, 0, 4)), { a: transcript() });
    expect(line).not.toHaveProperty("words");
  });
});

describe("speakerCutRanges", () => {
  const at = (start: number, end: number, role?: "interviewer"): LaneLine => ({
    id: `${start}`,
    assetId: "a",
    start,
    end,
    text: "",
    speaker: role ? "Q" : "A",
    speakerId: role ? "Q" : "A",
    partial: false,
    ...(role ? { role } : {}),
  });
  const isQ = (l: LaneLine) => l.role === "interviewer";

  it("takes the pauses around a question, leaving a handle on the answers", () => {
    expect(speakerCutRanges([at(0, 5), at(6, 8, "interviewer"), at(9, 15)], isQ)).toEqual([{ start: 5.2, end: 8.8 }]);
  });

  it("leaves a long pause alone and does not reach past the first or last line", () => {
    expect(speakerCutRanges([at(0, 2, "interviewer"), at(10, 15), at(15.5, 17, "interviewer")], isQ)).toEqual([
      { start: 0, end: 2 },
      { start: 15.2, end: 17 },
    ]);
  });

  it("never cuts into an answer that overlaps a question", () => {
    expect(speakerCutRanges([at(0, 4, "interviewer"), at(3, 10)], isQ)).toEqual([{ start: 0, end: 3 }]);
    expect(speakerCutRanges([at(0, 10), at(4, 6, "interviewer")], isQ)).toEqual([]);
  });
});
