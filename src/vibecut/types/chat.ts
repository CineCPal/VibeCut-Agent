/** The one type of VibeCut's src/types/chat.ts its chatArgs.ts needs (PLAN.md, "Phase 6b"). */

/** One line of an edit review (see lib/editReview.ts): a time to jump to and what is wrong there. */
export interface ChatReviewItem {
  /** Timeline seconds. */
  time: number;
  severity: "high" | "medium" | "low";
  text: string;
  /** "check": the automatic edit lint. "critic": the vision critic. */
  source: "check" | "critic";
}
