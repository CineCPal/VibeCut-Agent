/**
 * Review edits first (Phase 11d): a change waits on its card for Apply, Skip, or Apply all (for the
 * rest of that request). The controller asks; the card's buttons answer.
 */
export type ReviewDecision = "apply" | "skip" | "all";

const waiting = new Map<string, (decision: ReviewDecision) => void>();

/** Waits for the user's answer on card `cardId`. */
export function awaitReview(cardId: string): Promise<ReviewDecision> {
  return new Promise((resolve) => waiting.set(cardId, resolve));
}

/** The user's answer for a card; false when it wasn't waiting. */
export function answerReview(cardId: string, decision: ReviewDecision): boolean {
  const resolve = waiting.get(cardId);
  if (!resolve) return false;
  waiting.delete(cardId);
  resolve(decision);
  return true;
}

/** Skips every waiting change (Stop, or the job ending). */
export function skipAllReviews(): void {
  for (const id of [...waiting.keys()]) answerReview(id, "skip");
}

export const reviewsWaiting = (): number => waiting.size;
