import { describe, expect, it } from "vitest";
import { formatShortCount } from "./format";

describe("formatShortCount", () => {
  it("fits a DAG card's token badge", () => {
    expect([0, 980, 1_000, 9_840, 12_345, 98_765, 999_499, 1_234_567, 45_678_901].map(formatShortCount)).toEqual([
      "0", "980", "1.0k", "9.8k", "12k", "99k", "999k", "1.2M", "46M",
    ]);
  });
});
