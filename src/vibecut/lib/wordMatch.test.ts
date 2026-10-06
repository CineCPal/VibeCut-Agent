import { describe, expect, it } from "vitest";
import { findPhrase, normalizeWord, phraseTokens } from "./wordMatch";

const words = ["So,", "um,", "you", "know,", "we", "um", "Don't", "stop."].map((text, i) => ({ start: i, end: i + 0.5, text }));

describe("normalizeWord / phraseTokens", () => {
  it("lower-cases and strips punctuation but keeps apostrophes", () => {
    expect(normalizeWord("Um,")).toBe("um");
    expect(normalizeWord("Don't")).toBe("don't");
    expect(phraseTokens("  You KNOW, ")).toEqual(["you", "know"]);
  });
});

describe("findPhrase", () => {
  it("finds every single-word occurrence", () => {
    expect(findPhrase(words, ["um"])).toEqual([
      { start: 1, end: 1.5 },
      { start: 5, end: 5.5 },
    ]);
  });

  it("finds consecutive multi-word phrases spanning first start to last end", () => {
    expect(findPhrase(words, ["you", "know"])).toEqual([{ start: 2, end: 3.5 }]);
    expect(findPhrase(words, ["don't", "stop"])).toEqual([{ start: 6, end: 7.5 }]);
  });

  it("does not match words that are not adjacent, or an empty phrase", () => {
    expect(findPhrase(words, ["so", "you"])).toEqual([]);
    expect(findPhrase(words, [])).toEqual([]);
  });
});
