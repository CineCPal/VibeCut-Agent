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

/** Phase 14e: starters for the review, sound, beat, social and memory tools (Phases 12–14). A store saved
 * before them gets them once (the version 2 migration); a starter the user deleted earlier stays deleted. */
export const PACK_14: readonly Omit<SavedPrompt, "id">[] = [
  {
    name: "qc",
    body: "Run a delivery QC on this timeline with review_edit at {{-14}} LUFS, without the critic. List what it finds by severity, with each problem's time, and say which ones you'd fix and how. Don't change anything yet.",
  },
  {
    name: "notes",
    body: "Give me a picture editor's notes on this cut: run review_edit with the critic, for this brief: {{what the cut is for}}. Group the notes into pacing, continuity, framing and B-roll, most important first, and say what you'd change. Don't change anything yet.",
  },
  {
    name: "loudness-check",
    body: "Measure the loudness of every dialogue clip on this timeline and tell me which ones are off a {{-14}} LUFS target or peaking over -1 dBTP. Then propose levels with normalize_loudness, and apply them once I say so.",
  },
  {
    name: "describe-footage",
    body: "Look at the clips in the project that have no description yet (up to {{12}}), a contact sheet each with look_at_media, and log a one-line description of what's in each shot with set_clip_metadata: subject, framing, setting, and anything unusable.",
  },
  {
    name: "beat-markers",
    body: "Find the beats of the music on this timeline and put a marker on every {{4}}th beat, named by bar number, so I can cut to them. Say the tempo and how steady the beat is.",
  },
  {
    name: "beat-cut",
    body: "Cut B-roll to the music on this timeline with cut_to_beats: find shots about {{topic}} with find_broll (or the project's B-roll), a cut every 2 beats, from the music's start to its end. Tell me which shots you used, and that Revert takes it all away.",
  },
  {
    name: "social-cutdown",
    body: "Make a {{30}}-second social cut of this timeline: in a draft, keep the strongest moments (the hook first, a clear ending), send it, then make_social_version {{9:16}} from it. Tell me what you kept and anything that needs moving by hand, like titles.",
  },
  {
    name: "client-brief",
    body: "Help me set up this project's notes. Ask me, a few at a time, about the client and brief, the people on camera, the style (pace, music, what to avoid) and the deliverables (lengths, aspect ratios, loudness, deadlines), then remember_note each answer in the right section.",
  },
  {
    name: "chapters",
    body: "Write YouTube chapters for this timeline from its markers and what's said in the transcripts: 00:00 first, each chapter at least 10 seconds long, with short, specific titles. Give them as a list I can paste into the description.",
  },
  {
    name: "whats-changed",
    body: "Summarize what you've changed on this timeline and in the project this session, from get_edit_log: grouped by request, in plain words, with what's been reverted and which backups hold the earlier versions.",
  },
];

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
  ...PACK_14,
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

/** A store saved before version 2 gains Phase 14e's starters it doesn't have by name. */
export function addPack14(persisted: unknown, version: number): { prompts: unknown[] } {
  const saved = (persisted as { prompts?: unknown } | undefined)?.prompts;
  const prompts: unknown[] = Array.isArray(saved) ? saved : [];
  if (version >= 2) return { prompts };
  const names = new Set(prompts.filter(isPrompt).map((p) => p.name));
  return { prompts: [...prompts, ...PACK_14.filter((p) => !names.has(p.name)).map((p) => ({ ...p, id: newId() }))] };
}

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
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ prompts: state.prompts }),
      // Version 2 (Phase 14e): the new starters, once, beside whatever the user has.
      migrate: (persisted, version) => addPack14(persisted, version),
      // A hand-edited or corrupt entry is dropped rather than breaking the composer.
      merge: (persisted, current) => {
        const saved = (persisted as { prompts?: unknown } | undefined)?.prompts;
        return Array.isArray(saved) ? { ...current, prompts: saved.filter(isPrompt) } : current;
      },
    },
  ),
);
