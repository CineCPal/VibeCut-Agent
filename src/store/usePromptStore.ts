/**
 * Saved prompts (Phase 8h): reusable messages, picked by typing `/name` in the composer and kept in
 * Settings → Saved prompts. Stored in this browser's localStorage; they never leave the machine.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { newId } from "../lib/id";

export interface SavedPrompt {
  id: string;
  /** What's typed after "/": lowercase letters, digits and hyphens. */
  name: string;
  /** The message it puts in the composer. A `{{…}}` in it is selected, for the user to type over. */
  body: string;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_BODY_CHARS = 4000;

export const STARTER_PROMPTS: readonly Omit<SavedPrompt, "id">[] = [
  {
    name: "markers-from-transcript",
    body: "Read the transcripts of the interviews on this timeline and put a marker on each strong quote: name it with its first few words and put the whole line in its note.",
  },
  {
    name: "find-silences",
    body: "Find the silences longer than a second in the dialogue on this timeline and list where they are. Don't cut anything yet.",
  },
  {
    name: "rough-cut",
    body: "Make a rough cut of the interviews on this timeline in a draft: keep the clearest answers about {{topic}}, drop false starts, fillers and long pauses, and tell me what you left out. Don't send it until I've looked.",
  },
  {
    name: "broll-ideas",
    body: "Suggest B-roll for this timeline: for each stretch of interview that would be better covered, say where it is and what kind of shot would help, and search the B-roll Library for candidates.",
  },
  {
    name: "summarize-timeline",
    body: "Summarize this timeline: its length, what's on each track, the markers, and anything that looks unfinished (gaps, switched-off clips, clips past the end).",
  },
];

/** Why `name` can't be a prompt's name (another prompt has it, or it isn't a slug), or null. */
export function nameProblem(name: string, prompts: SavedPrompt[], ownId?: string): string | null {
  if (!name) return "Give it a name";
  if (!NAME_PATTERN.test(name)) return "Use lowercase letters, digits and hyphens (up to 32), starting with a letter or digit";
  if (prompts.some((p) => p.name === name && p.id !== ownId)) return `There's already a /${name}`;
  return null;
}

function bodyProblem(body: string): string | null {
  if (!body.trim()) return "Write the message it puts in the box";
  if (body.length > MAX_BODY_CHARS) return `Keep it under ${MAX_BODY_CHARS.toLocaleString("en-US")} characters`;
  return null;
}

/** The saved prompts whose names start with, then contain, `query` (what follows the "/"). */
export function matchingPrompts(prompts: SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.toLowerCase();
  const starts = prompts.filter((p) => p.name.startsWith(q));
  return [...starts, ...prompts.filter((p) => !p.name.startsWith(q) && p.name.includes(q))];
}

const starters = (): SavedPrompt[] => STARTER_PROMPTS.map((p) => ({ ...p, id: newId() }));

function isPrompt(value: unknown): value is SavedPrompt {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && NAME_PATTERN.test(v.name) && typeof v.body === "string";
}

export interface PromptState {
  prompts: SavedPrompt[];
  /** Adds a prompt. Answers why it can't be, or null. */
  add: (name: string, body: string) => string | null;
  /** Changes a prompt. Answers why it can't be, or null. */
  update: (id: string, name: string, body: string) => string | null;
  remove: (id: string) => void;
  /** Puts back any starter missing by name; prompts the user has are left as they are. */
  restoreStarters: () => void;
}

export const usePromptStore = create<PromptState>()(
  persist(
    (set, get) => ({
      prompts: starters(),
      add: (name, body) => {
        const problem = nameProblem(name, get().prompts) ?? bodyProblem(body);
        if (problem) return problem;
        set((s) => ({ prompts: [...s.prompts, { id: newId(), name, body }] }));
        return null;
      },
      update: (id, name, body) => {
        const problem = nameProblem(name, get().prompts, id) ?? bodyProblem(body);
        if (problem) return problem;
        set((s) => ({ prompts: s.prompts.map((p) => (p.id === id ? { ...p, name, body } : p)) }));
        return null;
      },
      remove: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),
      restoreStarters: () =>
        set((s) => ({
          prompts: [...s.prompts, ...starters().filter((starter) => !s.prompts.some((p) => p.name === starter.name))],
        })),
    }),
    {
      name: "vibecut-agent.prompts",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ prompts: state.prompts }),
      // A hand-edited or corrupt entry is dropped rather than breaking the composer.
      merge: (persisted, current) => {
        const saved = (persisted as { prompts?: unknown } | undefined)?.prompts;
        return Array.isArray(saved) ? { ...current, prompts: saved.filter(isPrompt) } : current;
      },
    },
  ),
);
