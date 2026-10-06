import type { TranscriptWord } from "../types/transcript";
import type { TimeRange } from "./timeline";

/** A word as compared: lower case, punctuation stripped (apostrophes kept, so "don't" stays one word). */
export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
}

/** The words of a phrase, normalized, blanks dropped. */
export function phraseTokens(phrase: string): string[] {
  return phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
}

/** Every place `tokens` occurs as consecutive words, as the time range from its first word's start
 * to its last word's end. Occurrences never overlap (the scan resumes after each match). */
export function findPhrase(words: readonly TranscriptWord[], tokens: readonly string[]): TimeRange[] {
  if (tokens.length === 0) return [];
  const normalized = words.map((w) => normalizeWord(w.text));
  const found: TimeRange[] = [];
  for (let i = 0; i + tokens.length <= words.length; ) {
    if (tokens.every((t, k) => normalized[i + k] === t)) {
      found.push({ start: words[i].start, end: words[i + tokens.length - 1].end });
      i += tokens.length;
    } else {
      i++;
    }
  }
  return found;
}

/** Hesitations that are almost never part of what someone meant to say. Phrases like "you know" or
 * "I mean" are left out on purpose: they are often meaningful, so they are only cut when asked for. */
export const DEFAULT_FILLERS = ["um", "umm", "uh", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm"];
