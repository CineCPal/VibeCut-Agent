/** "tool": a tool call the agent made (a card, Phase 8f), or a note about the turn (a retry, a revert);
 * "error": something went wrong (shown in red). */
export type ChatRole = "user" | "assistant" | "system" | "tool" | "error";

export type ChatMessageStatus = "pending" | "done" | "error";

/** One tool call, shown as a card (Phase 8f). Its message's `text` is the one-line summary. */
export interface ChatToolCall {
  name: string;
  /** The call's arguments and its result as pretty JSON, each cut to TOOL_DETAIL_CHARS. */
  args: string;
  result?: string;
  state: "running" | "done" | "failed";
}

/** An image sent with a user message (Phase 8g). Its bytes are filed beside the chat (`chat_attachment_*`). */
export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

/** An image in the composer, ready to send: its base64 `data` and a `dataUrl` to show it. */
export interface PendingImage extends ChatAttachment {
  data: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  status?: ChatMessageStatus;
  /** On a "tool" message for a tool call; notes about the turn have none. */
  tool?: ChatToolCall;
  /** Images sent with a user message. */
  attachments?: ChatAttachment[];
}

/**
 * offline: can't chat yet (sidecar starting, or the model's API key is missing; `statusDetail` says).
 * idle: ready. thinking: a turn is running. stopping: Stop was pressed and the turn is winding down.
 * error: the sidecar stopped.
 */
export type AgentStatus = "offline" | "idle" | "thinking" | "stopping" | "error";

/** The sidecar's name for each provider (chat.py's PROVIDER_NAMES). "claude-code": Claude (subscription),
 * the user's own signed-in Claude Code CLI (Phase 7b). */
export type ChatProvider = "gemini" | "claude" | "claude-code";

/** The last message's turn as it can be taken back (Phase 8c): the history exactly as it was sent with
 * that message. Retry and Edit put it back, then send again. */
export interface LastTurn {
  userMessageId: string;
  history: unknown[];
  historyProvider: ChatProvider | null;
}

/** Token use for a turn, as the chat sidecar reports it. */
export interface ChatUsage {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  steps: number;
  /** Claude (subscription) only: what the turn would have cost on the API, by Claude Code's reckoning. */
  costUsd?: number;
}

/** Same ids as VibeCut's `useAiProviderStore`, so preferences carry over. */
export type AiChoiceId = "gemini" | "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-code-opus-5-5" | "claude-code-sonnet-5-5";

export type AiProvider = "gemini" | "anthropic";

/** What a choice needs to run: an API key (`AiProvider`), or the user's signed-in Claude Code. */
export type ChoiceAccess = AiProvider | "claude-code";

export interface AiChoice {
  id: AiChoiceId;
  label: string;
  /** Whose API key it needs (KeyStatus), or "claude-code" for none (the user's Claude subscription). */
  provider: ChoiceAccess;
  /** How the chat sidecar names the provider, and the model id it's given (none: the sidecar's default). */
  chatProvider: ChatProvider;
  model?: string;
}

export const AI_CHOICES: readonly AiChoice[] = [
  { id: "gemini", label: "Gemini", provider: "gemini", chatProvider: "gemini" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", chatProvider: "claude", model: "claude-opus-5-5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic", chatProvider: "claude", model: "claude-sonnet-5-5" },
  { id: "claude-code-opus-5-5", label: "Claude Opus 5.5 (subscription)", provider: "claude-code", chatProvider: "claude-code", model: "claude-opus-5-5" },
  { id: "claude-code-sonnet-5-5", label: "Claude Sonnet 5.5 (subscription)", provider: "claude-code", chatProvider: "claude-code", model: "claude-sonnet-5-5" },
];

/** How long Claude thinks (Phase 9a): the API's `output_config.effort`, Claude Code's `--effort`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: EffortLevel = "medium";

/** Effort is set per Claude model, the same on the API and on the subscription. */
export type ClaudeFamily = "opus" | "sonnet";

/** Which Claude model a choice runs, or null for Gemini. */
export function familyOf(choice: AiChoice): ClaudeFamily | null {
  if (choice.chatProvider === "gemini") return null;
  return choice.model?.includes("opus") ? "opus" : "sonnet";
}

/** The Story Editor's first pass over long footage (Phase 7e): the story's own provider (Sonnet on
 * Claude, Flash on Gemini), or always Gemini Flash (needs a Gemini key). */
export type StoryFirstPass = "same" | "gemini";

/** Mirrors `ClaudeCodeStatus` in src-tauri/src/claude_code.rs. */
export interface ClaudeCodeStatus {
  program: string | null;
  programSaved: string | null;
  configDir: string | null;
  /** Null when it couldn't be checked. */
  signedIn: boolean | null;
  email: string | null;
  subscription: string | null;
  /** Why it isn't usable, when it isn't. */
  detail: string | null;
}

/** Whether a Claude Code check says a subscription turn can start. */
export function claudeCodeUsable(status: ClaudeCodeStatus | null): boolean {
  return Boolean(status?.program) && status?.signedIn !== false;
}

export const KEY_ENV: Record<AiProvider, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
