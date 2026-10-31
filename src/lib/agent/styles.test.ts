import { describe, expect, it } from "vitest";

import { findStyle, parseStyles, styleLook, styleName, styleTag, styleTarget, withStyle, type LearnedStyle } from "./styles";

const PROMO: LearnedStyle = { name: "Client promo", medianShot: 2.4, p90Shot: 4.1, cutsPerMinute: 22.5, brightness: 0.41, contrast: 0.62, warmth: 0.08, tint: -0.01, colour: 0.19, onBeat: 0.7, bpm: 120 };

describe("learned styles in the notes", () => {
  it("writes a tag that reads back as the same style", () => {
    expect(styleTag(PROMO)).toBe('{style "Client promo" medianShot=2.4 p90Shot=4.1 cutsPerMinute=22.5 brightness=0.41 contrast=0.62 warmth=0.08 tint=-0.01 colour=0.19 onBeat=0.7 bpm=120}');
    const notes = withStyle("## Brief\n- A school promo\n", PROMO, '"Client promo" style, learned from promo.mp4.', "2026-10-31");
    expect(notes).toBe(`## Brief\n- A school promo\n\n## Style\n- "Client promo" style, learned from promo.mp4. ${styleTag(PROMO)} (2026-10-31)\n`);
    expect(parseStyles(notes)).toEqual([PROMO]);
  });

  it("replaces a style of the same name and keeps the others", () => {
    const slow: LearnedStyle = { name: "doc", medianShot: 6, p90Shot: 12, cutsPerMinute: 8 };
    let notes = withStyle("## Style\n- No whip pans\n", PROMO, "Promo.", "2026-10-30");
    notes = withStyle(notes, slow, "Doc.", "2026-10-30");
    notes = withStyle(notes, { ...PROMO, medianShot: 2 }, "Promo, again.", "2026-10-31");
    expect(notes.split("\n").filter((l) => l.startsWith("-")).map((l) => l.split(" {")[0])).toEqual(["- No whip pans", "- Doc.", "- Promo, again."]);
    expect(parseStyles(notes).map((s) => [s.name, s.medianShot])).toEqual([
      ["doc", 6],
      ["Client promo", 2],
    ]);
  });

  it("finds a style by name, whatever its case, and says which there are", () => {
    const notes = withStyle("", PROMO, "Promo.", "2026-10-31");
    expect(findStyle(notes, "client PROMO").medianShot).toBe(2.4);
    expect(() => findStyle(notes, "wedding")).toThrow('There\'s no learned style "wedding"; the project has "Client promo"');
    expect(() => findStyle("## Style\n- No whip pans\n", "promo")).toThrow("No style has been learned");
    // A line someone broke by hand is left out, not misread.
    expect(parseStyles('- {style "x" medianShot=2}\n')).toEqual([]);
  });

  it("gives a style's pace as a target and its look", () => {
    expect(styleTarget(PROMO)).toEqual({ medianShot: 2.4, maxShot: 8.2 });
    expect(styleLook(PROMO)).toEqual({ brightness: 0.41, contrast: 0.62, warmth: 0.08, tint: -0.01, colour: 0.19 });
    expect(() => styleLook({ name: "x", medianShot: 2, p90Shot: 3, cutsPerMinute: 20 })).toThrow("has no look");
  });

  it("checks names", () => {
    expect(styleName("  client   promo ")).toBe("client promo");
    for (const bad of ["", 'the "best"', "a{b}", "x".repeat(41), undefined]) expect(() => styleName(bad)).toThrow("name must be");
  });
});
