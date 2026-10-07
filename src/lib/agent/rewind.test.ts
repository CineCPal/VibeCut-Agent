import { describe, expect, it } from "vitest";
import { lastTurnFrom, rewindOf } from "./rewind";
import type { ChatMessage } from "../../types/agent";

const msg = (id: string, role: ChatMessage["role"]): ChatMessage => ({ id, role, text: id, createdAt: 1 });
const messages = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")];

describe("rewind (Phase 8c)", () => {
  it("keeps only the history's length for Gemini and Claude, and the session for Claude Code", () => {
    expect(rewindOf({ userMessageId: "u2", history: ["a", "b"], historyProvider: "gemini" }, messages)).toEqual({ userMessageId: "u2", historyLength: 2 });
    expect(rewindOf({ userMessageId: "u2", history: [{ claudeCodeSession: "s1" }], historyProvider: "claude-code" }, messages)).toEqual({ userMessageId: "u2", session: "s1" });
    expect(rewindOf({ userMessageId: "u2", history: [], historyProvider: null }, messages)).toEqual({ userMessageId: "u2", historyLength: 0 });
    expect(rewindOf({ userMessageId: "gone", history: [], historyProvider: null }, messages)).toBeUndefined();
    expect(rewindOf(null, messages)).toBeUndefined();
  });

  it("comes back as the history the turn started from", () => {
    const chat = { messages, history: ["a", "b", "c", "d"], provider: "claude" as const };
    expect(lastTurnFrom({ userMessageId: "u2", historyLength: 2 }, chat)).toEqual({ userMessageId: "u2", history: ["a", "b"], historyProvider: "claude" });
    expect(lastTurnFrom({ userMessageId: "u2", historyLength: 0 }, chat)).toEqual({ userMessageId: "u2", history: [], historyProvider: null });
    expect(lastTurnFrom({ userMessageId: "u2", session: "s0" }, { ...chat, provider: "claude-code" })).toEqual({
      userMessageId: "u2",
      history: [{ claudeCodeSession: "s0" }],
      historyProvider: "claude-code",
    });
    expect(lastTurnFrom({ userMessageId: "u2", session: null }, chat)).toEqual({ userMessageId: "u2", history: [], historyProvider: null });
  });

  it("is dropped when it doesn't fit the chat it came with", () => {
    const chat = { messages, history: ["a", "b"], provider: "gemini" as const };
    expect(lastTurnFrom({ userMessageId: "u1", historyLength: 0 }, chat)).toBeNull(); // not the last request
    expect(lastTurnFrom({ userMessageId: "u2", historyLength: 5 }, chat)).toBeNull(); // longer than what's kept
    expect(lastTurnFrom({ userMessageId: "u2", historyLength: 1 }, { ...chat, history: [], historyDropped: true })).toBeNull();
    expect(lastTurnFrom({ userMessageId: "u2", historyLength: 1.5 }, chat)).toBeNull();
    expect(lastTurnFrom({ userMessageId: "u2", session: "" }, chat)).toBeNull();
    expect(lastTurnFrom("nonsense", chat)).toBeNull();
    expect(lastTurnFrom(undefined, chat)).toBeNull();
  });
});
