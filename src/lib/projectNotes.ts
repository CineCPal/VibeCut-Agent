/**
 * Project notes (PLAN.md, "Phase 13c"): what the agent remembers about one editor project, kept across
 * chats and providers in a Markdown file per project (project_notes.rs). The snapshot puts them first;
 * the agent adds and removes lines with remember_note / forget_note (notesTools.ts), and the user edits
 * them in the Notes window.
 *
 * The notes are Markdown: a `## Section` heading per kind of fact, a `- line` per fact.
 */
import { invoke } from "@tauri-apps/api/core";
import type { NleHost } from "../types/nle";

/** project_notes.rs's MAX_NOTES_BYTES. */
export const MAX_NOTES_BYTES = 16 * 1024;

export const NOTE_SECTIONS = ["brief", "people", "style", "deliverables", "decisions"] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];

export const SECTION_TITLES: Record<NoteSection, string> = {
  brief: "Brief",
  people: "People",
  style: "Style",
  deliverables: "Deliverables",
  decisions: "Decisions",
};

export function loadNotes(host: NleHost, project: string): Promise<string> {
  return invoke<string>("project_notes_get", { host, project });
}

export function saveNotes(host: NleHost, project: string, text: string): Promise<void> {
  if (new TextEncoder().encode(text).length > MAX_NOTES_BYTES) {
    return Promise.reject(new Error(`Project notes can hold at most ${MAX_NOTES_BYTES / 1024} KB`));
  }
  return invoke("project_notes_set", { host, project, text });
}

/** `text` with `- line` added at the end of its section, the section made (in NOTE_SECTIONS order) when
 * there's none. A line already there (ignoring case and spaces) isn't added twice: null then. */
export function withNote(text: string, section: NoteSection, line: string): string | null {
  const title = SECTION_TITLES[section];
  const lines = text.trim() ? text.replace(/\s+$/, "").split("\n") : [];
  const same = (a: string) => a.replace(/^-\s*/, "").replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (lines.some((l) => l.startsWith("-") && same(l) === same(line))) return null;
  const bullet = `- ${line}`;
  const headingAt = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (headingAt >= 0) {
    let end = headingAt + 1;
    while (end < lines.length && !lines[end].startsWith("## ")) end++;
    while (end > headingAt + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, bullet);
    return `${lines.join("\n")}\n`;
  }
  // A new section goes before the first known section that comes after it.
  const later = NOTE_SECTIONS.slice(NOTE_SECTIONS.indexOf(section) + 1).map((s) => `## ${SECTION_TITLES[s].toLowerCase()}`);
  const before = lines.findIndex((l) => later.includes(l.trim().toLowerCase()));
  const block = [`## ${title}`, bullet, ""];
  if (before >= 0) lines.splice(before, 0, ...block);
  else lines.push(...(lines.length ? [""] : []), ...block.slice(0, 2));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
}

/** The note lines matching `words` (all of them, ignoring case), with their line numbers. */
export function matchingNotes(text: string, words: string): { index: number; line: string }[] {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  if (!wanted.length) return [];
  return text
    .split("\n")
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line.startsWith("-") && wanted.every((w) => line.toLowerCase().includes(w)));
}

/** `text` without line `index`, and without a section heading left with nothing under it. */
export function withoutLine(text: string, index: number): string {
  const lines = text.split("\n");
  lines.splice(index, 1);
  const kept = lines.filter((l, i) => {
    if (!l.startsWith("## ")) return true;
    const next = lines.slice(i + 1).find((n) => n.trim() !== "");
    return next !== undefined && !next.startsWith("## ");
  });
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`.replace(/^\n$/, "");
}

/** The snapshot's first block: the notes, or how to start them. */
export function notesContext(project: string, text: string): string {
  const body = text.trim();
  if (!body) return `[PROJECT NOTES for "${project}": none yet. remember_note saves lasting facts the user tells you (brief, people, style, deliverables, decisions).]`;
  return `[PROJECT NOTES for "${project}" (kept across chats; remember_note / forget_note change them)]\n${body}\n[END PROJECT NOTES]`;
}
