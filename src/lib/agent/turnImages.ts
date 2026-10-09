/**
 * How many images the tools may hand the model for one request (Phase 13b). Each image costs about a
 * thousand or more tokens and stays in view for the rest of the turn, so a request gets MAX_TURN_IMAGES.
 * The look_at_* tools check what's left before reading frames; the controller keeps the count.
 */
export const MAX_TURN_IMAGES = 8;
/** Images one tool call may return. */
export const MAX_CALL_IMAGES = 2;

let current = { step: "", used: 0 };

export function imagesLeft(step: string): number {
  return current.step === step ? Math.max(0, MAX_TURN_IMAGES - current.used) : MAX_TURN_IMAGES;
}

/** Counts `wanted` images against the request's budget and says how many may go. */
export function takeImages(step: string, wanted: number): number {
  if (current.step !== step) current = { step, used: 0 };
  const allowed = Math.min(wanted, MAX_CALL_IMAGES, MAX_TURN_IMAGES - current.used);
  current.used += Math.max(0, allowed);
  return Math.max(0, allowed);
}

export function resetTurnImagesForTests(): void {
  current = { step: "", used: 0 };
}
