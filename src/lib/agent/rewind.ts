/**
 * The last turn as it can be taken back (PLAN.md, Phase 8c), to and from what's saved with a chat.
 * Pure, so the agent store and the chat history can both use it.
 */
import type { ChatMessage, ChatProvider, LastTurn } from "../../types/agent";
import type { ChatRewind } from "../../types/history";

/** The Claude Code session a history names, if it's one. */
function sessionIn(history: unknown[]): string | null {
  const entry = history.find((e): e is { claudeCodeSession: string } => typeof e === "object" && e !== null && typeof (e as { claudeCodeSession?: unknown }).claudeCodeSession === "string");
  return entry?.claudeCodeSession ?? null;
}

/** What's saved for `turn`; undefined when there's no turn or its message is gone. */
export function rewindOf(turn: LastTurn | null, messages: ChatMessage[]): ChatRewind | undefined {
  if (!turn || !messages.some((m) => m.id === turn.userMessageId)) return undefined;
  if (turn.historyProvider === "claude-code") return { userMessageId: turn.userMessageId, session: sessionIn(turn.history) };
  return { userMessageId: turn.userMessageId, historyLength: turn.history.length };
}

/**
 * The turn back from what was saved, checked against the chat it came with; null when it doesn't fit
 * (its message is no longer the last request, or the history it needs wasn't kept).
 */
export function lastTurnFrom(
  rewind: unknown,
  chat: { messages: ChatMessage[]; history: unknown[]; provider: ChatProvider | null; historyDropped?: boolean },
): LastTurn | null {
  if (typeof rewind !== "object" || rewind === null) return null;
  const r = rewind as Record<string, unknown>;
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  if (typeof r.userMessageId !== "string" || r.userMessageId !== lastUser?.id) return null;
  if ("session" in r) {
    if (r.session === null) return { userMessageId: r.userMessageId, history: [], historyProvider: null };
    if (typeof r.session !== "string" || !r.session) return null;
    return { userMessageId: r.userMessageId, history: [{ claudeCodeSession: r.session }], historyProvider: "claude-code" };
  }
  const length = r.historyLength;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return null;
  if (length === 0) return { userMessageId: r.userMessageId, history: [], historyProvider: null };
  if (chat.historyDropped || !chat.provider || chat.provider === "claude-code" || length > chat.history.length) return null;
  return { userMessageId: r.userMessageId, history: chat.history.slice(0, length), historyProvider: chat.provider };
}
