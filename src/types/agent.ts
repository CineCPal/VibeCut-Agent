/** "tool": one line per tool call the agent made; "error": something went wrong (shown in red). */
export type ChatRole = "user" | "assistant" | "system" | "tool" | "error";

export type ChatMessageStatus = "pending" | "done" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  status?: ChatMessageStatus;
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

/** Token use for a turn, as the chat sidecar reports it. */
export interface ChatUsage {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  steps: number;
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
