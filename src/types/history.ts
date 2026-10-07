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

/** A chat as it's filed in `<app data>/history/chats/<id>.json` (Phase 8a). */
export interface SavedChat {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Whose history `history` is (the sidecar's provider name); null before the first answer. */
  provider: ChatProvider | null;
  aiChoice: AiChoiceId;
  messages: ChatMessage[];
  /** The provider's own history, or [] when it was too big to keep. */
  history: unknown[];
  historyDropped?: boolean;
}

/** The edit log as it's filed in `<app data>/history/edit-log.json`. */
export interface SavedEditLog {
  version: 1;
  entries: EditEntry[];
  backups: Record<string, string>;
  restoredIds: Record<NleHost, Record<string, string>>;
  /** The number the next entry's id takes, so ids aren't reused after trimming. */
  nextSeq?: number;
}
