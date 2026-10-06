import { describe, expect, it } from "vitest";
import type { TranscriptData } from "../types/transcript";
import { resolveSpeaker, speakerIds, speakerStats, speakerTag } from "./speakers";

const data = (extra: Partial<TranscriptData> = {}): TranscriptData => ({
  segments: [
    { start: 0, end: 2, text: "So how did it start?", speaker: "Speaker 1" },
    { start: 2, end: 12, text: "It started in a garage with two friends and a very old laptop.", speaker: "Speaker 2" },
    { start: 12, end: 13, text: "Right.", speaker: "Speaker 1" },
    { start: 13, end: 15, text: "And then what happened?", speaker: "Speaker 1" },
    { start: 15, end: 25, text: "Then we shipped it.", speaker: "Speaker 2" },
  ],
  speakers: ["Speaker 1", "Speaker 2"],
  speakerLabels: {},
  excludedSpeakers: [],
  ...extra,
});

describe("resolveSpeaker", () => {
  it("names a speaker from VibeCut, then the transcriber, then the id", () => {
    const d = data({ speakerLabels: { "Speaker 1": "Host", "Speaker 2": "Ana" }, speakerInfo: { "Speaker 1": { name: "Ben" } } });
    expect(resolveSpeaker(d, "Speaker 1")).toEqual({ id: "Speaker 1", name: "Ben", inferred: false });
    expect(resolveSpeaker(d, "Speaker 2").name).toBe("Ana");
    expect(resolveSpeaker(data(), "Speaker 2").name).toBe("Speaker 2");
  });

  it("treats a speaker excluded in the transcriber as a guessed interviewer, unless VibeCut has a role", () => {
    expect(resolveSpeaker(data({ excludedSpeakers: ["Speaker 1"] }), "Speaker 1")).toMatchObject({ role: "interviewer", inferred: true });
    const d = data({ excludedSpeakers: ["Speaker 1"], speakerInfo: { "Speaker 1": { role: "subject" } } });
    expect(resolveSpeaker(d, "Speaker 1")).toMatchObject({ role: "subject", inferred: false });
  });
});

describe("speakerTag", () => {
  it("marks the interviewer for the Story Editor", () => {
    expect(speakerTag({ id: "Speaker 1", name: "Ben", role: "interviewer" })).toBe("Interviewer (Ben)");
    expect(speakerTag({ id: "Speaker 1", name: "Speaker 1", role: "interviewer" })).toBe("Interviewer");
    expect(speakerTag({ id: "Speaker 2", name: "Ana", role: "subject" })).toBe("Ana");
    expect(speakerTag({ id: "Speaker 1", name: "interviewer", role: "interviewer" })).toBe("Interviewer");
  });
});

describe("speakerStats", () => {
  it("counts lines, talk time and questions, which give the interviewer away", () => {
    const stats = speakerStats(data());
    expect(stats.get("Speaker 1")).toMatchObject({ lines: 3, seconds: 5 });
    expect(stats.get("Speaker 1")!.questionShare).toBeCloseTo(2 / 3);
    expect(stats.get("Speaker 2")).toMatchObject({ lines: 2, seconds: 20, questionShare: 0 });
    expect(stats.get("Speaker 2")!.samples).toHaveLength(2);
  });

  it("lists speakers from the transcriber's list and the lines", () => {
    expect(speakerIds(data({ speakers: ["Speaker 2"] }))).toEqual(["Speaker 2", "Speaker 1"]);
  });
});
