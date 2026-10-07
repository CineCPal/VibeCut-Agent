import type { AiChoiceId, ChatMessage, ChatProvider } from "./agent";
import type { EditEntry } from "./edits";
import type { NleHost } from "./nle";

/** One row of the past-chats list; mirrors `ChatSummary` in src-tauri/src/chat_store.rs. */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** A saved chat that matches a search (Phase 8d); mirrors `SearchHit` in chat_store.rs. */
export interface ChatSearchHit {
  id: string;
  /** The words around the first match, on one line. */
  snippet: string;
  /** Where the match is in `snippet`, in characters. */
  matchStart: number;
  matchEnd: number;
}

/** A chat as it's filed in `<app data>/history/chats/<id>.json` (Phase 8a). */
export interface SavedChat {
  version: 1;
  id: string;
  /** The name the list shows: `customTitle`, else `autoTitle`, else the first request. */
  title: string;
  /** The user's name for it (Phase 8d). */
  customTitle?: string;
  /** The model's name for it, after its first answer (Phase 8d). */
  autoTitle?: string;
  createdAt: number;
  updatedAt: number;
  /** Whose history `history` is (the sidecar's provider name); null before the first answer. */
  provider: ChatProvider | null;
  aiChoice: AiChoiceId;
  messages: ChatMessage[];
  /** The provider's own history, or [] when it was too big to keep. */
  history: unknown[];
  historyDropped?: boolean;
  /** How to take the last message back (Phase 8c); absent when it can't be. */
  rewind?: ChatRewind;
}

/**
 * The last turn's starting point, kept small: Gemini's and Claude's histories only grow, so the length
 * they had is enough; Claude Code's is the session the turn forked from (null: it started a new one).
 */
export type ChatRewind = { userMessageId: string; historyLength: number } | { userMessageId: string; session: string | null };

/** The edit log as it's filed in `<app data>/history/edit-log.json`. */
export interface SavedEditLog {
  version: 1;
  entries: EditEntry[];
  backups: Record<string, string>;
  restoredIds: Record<NleHost, Record<string, string>>;
  /** The number the next entry's id takes, so ids aren't reused after trimming. */
  nextSeq?: number;
}
