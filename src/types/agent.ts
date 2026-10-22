/** "tool": a tool call the agent made (a card, Phase 8f), or a note about the turn (a retry, a revert);
 * "error": something went wrong (shown in red). */
export type ChatRole = "user" | "assistant" | "system" | "tool" | "error";

export type ChatMessageStatus = "pending" | "done" | "error";

/** A problem a review found (Phase 14a), shown on the tool's card as a position the user can jump to. */
export interface ToolFinding {
  /** Timeline seconds. */
  time: number;
  end?: number;
  severity: "high" | "medium" | "low";
  text: string;
  /** "check": the automatic check; "critic": the vision critic. */
  source: "check" | "critic";
}

/** One tool call, shown as a card (Phase 8f). Its message's `text` is the one-line summary. */
export interface ChatToolCall {
  name: string;
  /** The call's arguments and its result as pretty JSON, each cut to TOOL_DETAIL_CHARS. */
  args: string;
  result?: string;
  /** pending: waiting for the user's Apply or Skip (Review edits first, Phase 11d); declined: skipped. */
  state: "running" | "done" | "failed" | "pending" | "declined";
  /** What a review found (Phase 14a), each a position the user can jump to. */
  findings?: ToolFinding[];
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

/** What a user can point at with @ in the composer (Phase 11c). */
export type MentionKind = "timeline" | "clip" | "marker" | "media" | "speaker" | "shot";

/** One @-mention: `label` is what the message shows after the @; `ref` and `detail` are what the model is
 * told exactly (a clip's id and place, a Library shot's file and range). */
export interface ChatMention {
  kind: MentionKind;
  label: string;
  ref: string;
  detail?: string;
}

/** A message sent while the agent was busy, waiting its turn (Phase 11b). */
export interface QueuedMessage {
  id: string;
  text: string;
  images: PendingImage[];
  mentions: ChatMention[];
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
  /** What a user message pointed at with @ (Phase 11c). */
  mentions?: ChatMention[];
}

/**
 * offline: can't chat yet (sidecar starting, or the model's API key is missing; `statusDetail` says).
 * idle: ready. thinking: a turn is running. stopping: Stop was pressed and the turn is winding down.
 * error: the sidecar stopped.
 */
export type AgentStatus = "offline" | "idle" | "thinking" | "stopping" | "error";

/** The sidecar's name for each provider (chat.py's PROVIDER_NAMES). "claude-code": Claude (subscription),
 * the user's own signed-in Claude Code CLI (Phase 7b). "antigravity": Gemini (subscription), the user's
 * own signed-in Antigravity CLI (Phase 17). */
export type ChatProvider = "gemini" | "claude" | "claude-code" | "antigravity";

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
export type AiChoiceId =
  | "gemini"
  | "claude-opus-5-5"
  | "claude-sonnet-5-5"
  | "claude-code-opus-5-5"
  | "claude-code-sonnet-5-5"
  | "antigravity-gemini-4-argon"
  | "antigravity-gemini-3.8-flash";

export type AiProvider = "gemini" | "anthropic";

/** What a choice needs to run: an API key (`AiProvider`), or the user's signed-in Claude Code or agy. */
export type ChoiceAccess = AiProvider | "claude-code" | "antigravity";

export interface AiChoice {
  id: AiChoiceId;
  label: string;
  /** Whose API key it needs (KeyStatus), or "claude-code" / "antigravity" for none (the user's plan). */
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
  {
    id: "antigravity-gemini-4-argon",
    label: "Gemini 4 Argon (subscription)",
    provider: "antigravity",
    chatProvider: "antigravity",
    model: "gemini-4-argon",
  },
  {
    id: "antigravity-gemini-3.8-flash",
    label: "Gemini 3.8 Flash (subscription)",
    provider: "antigravity",
    chatProvider: "antigravity",
    model: "gemini-3.8-flash",
  },
];

/** How long Claude thinks (Phase 9a): the API's `output_config.effort`, Claude Code's `--effort`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: EffortLevel = "medium";

/** Effort is set per Claude model, the same on the API and on the subscription. */
export type ClaudeFamily = "opus" | "sonnet";

/** How long Gemini (subscription) thinks (Phase 17): agy's `-low`, `-medium` or `-high` model variant. */
export type AntigravityEffort = "low" | "medium" | "high";
export const ANTIGRAVITY_EFFORTS: readonly AntigravityEffort[] = ["low", "medium", "high"];

/** Which Claude model a choice runs, or null for Gemini (on a key or the subscription). */
export function familyOf(choice: AiChoice): ClaudeFamily | null {
  if (choice.chatProvider === "gemini" || choice.chatProvider === "antigravity") return null;
  return choice.model?.includes("opus") ? "opus" : "sonnet";
}

/** The Story Editor's first pass over long footage (Phase 7e): the story's own provider (Sonnet on
 * Claude, Flash on Gemini), or always Gemini Flash (needs a Gemini key). */
export type StoryFirstPass = "same" | "gemini";
/** Which model review_edit's critic runs on: Gemini Flash (the default: cheapest, and spares a Claude plan
 * or API budget), or the chat's own. */
export type CriticModel = "gemini" | "same";

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

/** Mirrors `AntigravityStatus` in src-tauri/src/antigravity.rs (Phase 17). */
export interface AntigravityStatus {
  program: string | null;
  programSaved: string | null;
  /** Null when it couldn't be checked. */
  signedIn: boolean | null;
  /** The Gemini families the account offers (e.g. "gemini-4-argon"), without the effort suffix. */
  models: string[];
  /** Whether VibeCut's tools are in agy's MCP config, and whether they're this build's. */
  toolsAdded: boolean;
  toolsCurrent: boolean;
  /** Why it isn't usable, when it isn't. */
  detail: string | null;
}

/** Whether an agy check says a Gemini (subscription) turn can start: installed, not signed out, with
 * this build's tools added. */
export function antigravityUsable(status: AntigravityStatus | null): boolean {
  return Boolean(status?.program) && status?.signedIn !== false && Boolean(status?.toolsCurrent);
}

/** Whether a Claude Code check says a subscription turn can start. */
export function claudeCodeUsable(status: ClaudeCodeStatus | null): boolean {
  return Boolean(status?.program) && status?.signedIn !== false;
}

export const KEY_ENV: Record<AiProvider, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
