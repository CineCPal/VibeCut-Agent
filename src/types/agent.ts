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

/** The sidecar's name for each provider (chat.py's PROVIDER_NAMES). */
export type ChatProvider = "gemini" | "claude";

/** Token use for a turn, as the chat sidecar reports it. */
export interface ChatUsage {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  steps: number;
}

/** Same ids as VibeCut's `useAiProviderStore`, so preferences carry over. */
export type AiChoiceId = "gemini" | "claude-opus-5-5" | "claude-sonnet-5-5";

export type AiProvider = "gemini" | "anthropic";

export interface AiChoice {
  id: AiChoiceId;
  label: string;
  /** Whose API key it needs (KeyStatus). */
  provider: AiProvider;
  /** How the chat sidecar names the provider, and the model id it's given (none: the sidecar's default). */
  chatProvider: ChatProvider;
  model?: string;
}

export const AI_CHOICES: readonly AiChoice[] = [
  { id: "gemini", label: "Gemini", provider: "gemini", chatProvider: "gemini" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", chatProvider: "claude", model: "claude-opus-5-5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic", chatProvider: "claude", model: "claude-sonnet-5-5" },
];

export const KEY_ENV: Record<AiProvider, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
