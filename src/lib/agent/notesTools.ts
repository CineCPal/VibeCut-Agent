/**
 * remember_note and forget_note (PLAN.md, "Phase 13c"): the agent keeps lasting facts about the editor
 * project in its notes (projectNotes.ts). Neither touches the editor, so neither goes through Revert or
 * review; the user sees and edits the notes in the Notes window.
 */
import { loadNotes, matchingNotes, MAX_NOTES_BYTES, NOTE_SECTIONS, type NoteSection, saveNotes, SECTION_TITLES, withNote, withoutLine } from "../projectNotes";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import { type Executor, optStr } from "./args";
import type { ToolContext, ToolDeclaration } from "./tools";

const MAX_NOTE_CHARS = 300;

const today = () => new Date().toISOString().slice(0, 10);

function projectOf(host: NleHost): string {
  const project = useNleStateStore.getState().hosts[host].project;
  if (!project) throw new Error("No project is open in the editor, so there are no project notes to change");
  return project;
}

export function notesToolDeclarations(): ToolDeclaration[] {
  return [
    {
      name: "remember_note",
      description: `Saves one lasting fact about this editor project to its notes, which every later chat on the project sees at the top of the snapshot: the brief (client, purpose, length, deadline), people (names, roles, who's who on camera), style (pace, music, looks, "always/never" rules), deliverables (formats, versions, platforms) or decisions made. Only facts and preferences the user stated or confirmed; never guesses or one-off instructions. One short line each (under ${MAX_NOTE_CHARS} characters). Tell the user what you saved.`,
      parameters: {
        type: "OBJECT",
        properties: {
          section: { type: "STRING", enum: [...NOTE_SECTIONS] },
          text: { type: "STRING", description: "The fact, as one short line." },
        },
        required: ["section", "text"],
      },
    },
    {
      name: "forget_note",
      description: "Removes one line from the project notes: the line containing every word of text. Use it when the user says a saved fact is wrong or no longer holds (then remember_note the new one).",
      parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "Words from the line to remove." } }, required: ["text"] },
    },
  ];
}

export function notesExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    remember_note: async (args) => {
      const section = optStr(args, "section") as NoteSection | undefined;
      if (!section || !NOTE_SECTIONS.includes(section)) throw new Error(`section must be one of ${NOTE_SECTIONS.join(", ")}`);
      const line = (optStr(args, "text") ?? "").replace(/\s+/g, " ").trim();
      if (!line) throw new Error("text must be the fact to save");
      if (line.length > MAX_NOTE_CHARS) throw new Error(`Keep a note under ${MAX_NOTE_CHARS} characters; split it or say it shorter`);
      const project = projectOf(host);
      const before = await loadNotes(host, project);
      const after = withNote(before, section, `${line} (${today()})`);
      if (after === null) return { summary: `Already in the project notes: ${line}`, result: { saved: false, reason: "That's already in the notes." } };
      if (new TextEncoder().encode(after).length > MAX_NOTES_BYTES) {
        throw new Error(`The project notes are full (${MAX_NOTES_BYTES / 1024} KB). forget_note lines that no longer hold, or ask the user to tidy them in Notes`);
      }
      await saveNotes(host, project, after);
      return { summary: `Remembered for "${project}" (${SECTION_TITLES[section]}): ${line}`, result: { saved: true, section: SECTION_TITLES[section], line } };
    },

    forget_note: async (args) => {
      const words = optStr(args, "text") ?? "";
      if (!words.trim()) throw new Error("text must be words from the line to remove");
      const project = projectOf(host);
      const before = await loadNotes(host, project);
      const found = matchingNotes(before, words);
      if (!found.length) throw new Error(`No line in the project notes has all of "${words}"; the snapshot shows the notes`);
      if (found.length > 1) throw new Error(`${found.length} lines match "${words}": ${found.map((f) => f.line).join(" | ")}. Give more words from the one to remove`);
      await saveNotes(host, project, withoutLine(before, found[0].index));
      const line = found[0].line.replace(/^-\s*/, "");
      return { summary: `Forgot from "${project}"'s notes: ${line}`, result: { removed: line } };
    },
  };
}

/** The ground rule the system prompt gains (Phase 13c). */
export const NOTES_INSTRUCTION = `- The snapshot starts with the project's notes, kept across chats: follow them (names, style rules,
  deliverables) without being told again. When the user states a lasting fact or preference about this
  project ("the client is…", "always…", "never…", "the deadline is…"), remember_note it and say so in a
  few words. Don't save guesses, one-off requests or what the timeline already shows.`;
