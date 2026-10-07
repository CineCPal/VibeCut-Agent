/**
 * Drives a conversation with the editing agent (PLAN.md, Phase 4), ported from VibeCut's
 * chatActions.ts and cut to this app: one `chat` sidecar job per conversation, kept for later messages.
 *
 * - send: puts a snapshot of the open timeline ahead of the message, then starts the job (Rust injects
 *   the provider's key) or sends `user_message` to the running one.
 * - `tool_calls`: runs each call in order through the editor's watcher and answers with `tool_result`.
 * - `reply_delta` / `reply_break` / `reply_reset` (Phase 8b): the reply as it's written, into one live
 *   message; text said before a tool call stays a message of its own.
 * - `result`: the reply (it replaces the streamed text), and the history to resend next time; `error` or
 *   the job's exit ends it.
 * - retry / edit (Phase 8c): the last turn is taken back (its edits reverted first) and sent again.
 * - stop: `abort_turn`. Switching editor or model starts a new job; switching provider also starts the
 *   history over, since Gemini's and Claude's histories don't mix.
 */
import { cancelSidecar, onSidecarEvent, onSidecarExit, sendToSidecar, startSidecar } from "../ipc";
import { newId } from "../id";
import { refreshAgentStatus } from "./availability";
import { describeError, snapshotFor } from "./context";
import { revertLastRequest } from "./edits";
import { systemInstruction } from "./prompt";
import { executorsFor, runTool, toolDeclarations, type ToolContext } from "./tools";
import type { ToolOutcome } from "./args";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import type { ChatProvider, ChatUsage } from "../../types/agent";
import { AI_CHOICES } from "../../types/agent";
import type { SavedChat } from "../../types/history";

const PROVIDER_LABEL: Record<ChatProvider, string> = { gemini: "Gemini", claude: "Claude", "claude-code": "Claude (subscription)" };

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** What the current job's tools act on and how it was started; set when a turn begins. */
let context: ToolContext | null = null;
let provider: ChatProvider = "gemini";
/** The assistant message the reply is streaming into, if one is. */
let liveReplyId: string | null = null;

function parseUsage(value: unknown): ChatUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const n = (key: string) => (typeof v[key] === "number" ? (v[key] as number) : 0);
  return { promptTokens: n("promptTokens"), cachedTokens: n("cachedTokens"), outputTokens: n("outputTokens"), thoughtsTokens: n("thoughtsTokens"), steps: n("steps") };
}

/** Ends the streamed message as it stands; a blank one is removed. */
function settleLiveReply(): void {
  if (!liveReplyId) return;
  const store = useAgentStore.getState();
  const live = store.messages.find((m) => m.id === liveReplyId);
  if (live && !live.text.trim()) store.removeMessage(liveReplyId);
  else if (live) store.updateMessage(liveReplyId, { status: "done" });
  liveReplyId = null;
}

function endTurn(): void {
  useAgentStore.getState().setStatus("idle");
  refreshAgentStatus();
}

/** Ends the job on our side: the next message starts a new one. */
function sessionEnded(): void {
  settleLiveReply();
  context = null;
  useAgentStore.getState().endSession();
  useAgentStore.getState().setStatus("idle");
  refreshAgentStatus();
}

/** Sends one user message to the agent. Does nothing unless the agent is idle. */
export async function sendUserMessage(text: string): Promise<void> {
  const store = useAgentStore.getState();
  const words = text.trim();
  // An outside client (MCP, Phase 7a) is editing: one driver at a time. The composer says so too.
  if (!words || store.status !== "idle" || useMcpStore.getState().outsideRunning > 0) return;
  const step = store.addMessage({ role: "user", text: words, status: "done" });
  store.setStatus("thinking");
  store.setActivity("Reading the timeline…");

  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  const timeline = host ? nle.hosts[host].timeline : null;
  const choice = AI_CHOICES.find((c) => c.id === store.aiChoice) ?? AI_CHOICES[0];
  const userMessage = `${await snapshotFor(host, timeline)}\n\n${words}`;
  const key = `${choice.id}:${host ?? "none"}`;
  context = host ? { host, timeline, step, stepText: words } : null;
  provider = choice.chatProvider;
  useAgentStore.getState().setActivity(`Calling ${PROVIDER_LABEL[provider]}…`);

  const current = useAgentStore.getState();
  const history = current.historyProvider === provider ? current.history : [];
  // What Retry and Edit go back to (Phase 8c). Claude Code's turn forks its session, so this one stays.
  current.setLastTurn({ userMessageId: step, history, historyProvider: history.length ? provider : null });
  if (current.jobId && current.sessionKey === key) {
    try {
      await sendToSidecar(current.jobId, { type: "user_message", userMessage, history });
      return;
    } catch {
      // The job died between turns; start a new one below.
    }
  }
  if (current.jobId) {
    const old = current.jobId;
    useAgentStore.getState().endSession();
    sendToSidecar(old, { type: "end_session" }).catch(() => cancelSidecar(old).catch(() => undefined));
  }

  const jobId = newId().replace(/[^\w-]/g, "").slice(0, 64);
  useAgentStore.getState().setSession(jobId, key);
  try {
    await startSidecar(jobId, "chat", {
      provider,
      ...(choice.model ? { model: choice.model } : {}),
      systemInstruction: systemInstruction(host),
      toolDeclarations: host ? toolDeclarations(host) : [],
      history,
      userMessage,
    });
  } catch (error) {
    useAgentStore.getState().addMessage({ role: "error", text: describeError(error) });
    sessionEnded();
  }
}

/** The last turn's timeline edits that haven't been reverted (Phase 8c). */
export function lastTurnEdits(): string[] {
  const turn = useAgentStore.getState().lastTurn;
  if (!turn) return [];
  return useEditLogStore
    .getState()
    .entries.filter((e) => e.step === turn.userMessageId && !e.reverted)
    .map((e) => e.id);
}

/** Why the last message can't be taken back right now, or null when it can. */
export function rewindBlockReason(): string | null {
  const { lastTurn, status, messages } = useAgentStore.getState();
  if (!lastTurn || !messages.some((m) => m.id === lastTurn.userMessageId)) return "There's no message to take back";
  if (status !== "idle") return "Finish or stop the current request first";
  if (useMcpStore.getState().outsideRunning > 0) return "Claude Code is editing from outside";
  const edits = lastTurnEdits();
  if (edits.length) {
    // Revert undoes the newest request's edits; if a later one (a B-roll placement) made edits since,
    // those would go instead, so the user reverts them first.
    const newest = new Set(lastEditStep());
    if (!edits.every((id) => newest.has(id))) return "Edits were made after this request; revert those first";
  }
  return null;
}

/**
 * Takes the last turn back (Phase 8c): reverts its timeline edits, if it made any, then removes its
 * message and everything after it and puts the history back as it was sent. Answers that message's text.
 * Throws, leaving the conversation as it is, when it can't, or when any edit couldn't be fully undone.
 */
export async function rewindLastTurn(): Promise<string> {
  const reason = rewindBlockReason();
  if (reason) throw new Error(reason);
  const store = useAgentStore.getState();
  const turn = store.lastTurn!;
  const text = store.messages.find((m) => m.id === turn.userMessageId)!.text;
  let revertSummary: string | null = null;
  if (lastTurnEdits().length) {
    const outcome = await revertLastRequest();
    const result = outcome.result as { changedSince?: unknown[]; failed?: unknown[] };
    if (result.changedSince?.length || result.failed?.length) {
      useAgentStore.getState().addMessage({ role: "tool", text: outcome.summary });
      throw new Error("Not every edit of that request could be undone, so the conversation is left as it is. Check the timeline, then send a new message.");
    }
    revertSummary = outcome.summary;
  }
  // The job stays: the history goes with every message, and Claude Code resumes the session it names.
  useAgentStore.getState().takeBackLastTurn();
  if (revertSummary) useAgentStore.getState().addMessage({ role: "tool", text: revertSummary });
  return text;
}

/** Puts the last message in the composer to be edited (Phase 8c). False when it can't be now. */
export function startEditingLastMessage(): boolean {
  if (rewindBlockReason()) return false;
  const store = useAgentStore.getState();
  const message = store.messages.find((m) => m.id === store.lastTurn?.userMessageId);
  if (!message) return false;
  store.setDraft(message.text);
  store.setEditing(message.id);
  return true;
}

/** Leaves editing; the composer empties. */
export function cancelEditing(): void {
  const store = useAgentStore.getState();
  if (!store.editingMessageId) return;
  store.setEditing(null);
  store.setDraft("");
}

/** Retry: the last message again, from where it started. */
export async function retryLastTurn(): Promise<void> {
  const text = await rewindLastTurn();
  await sendUserMessage(text);
}

/** Edit: the last message replaced with `text`, from where it started. */
export async function sendEditedMessage(text: string): Promise<void> {
  if (!text.trim()) return;
  await rewindLastTurn();
  await sendUserMessage(text);
}

/** Stop: the sidecar ends the turn at its next check; tools already running finish first. */
export async function stopTurn(): Promise<void> {
  const { jobId, status } = useAgentStore.getState();
  if (!jobId || status !== "thinking") return;
  useAgentStore.getState().setStatus("stopping");
  useAgentStore.getState().setActivity("Stopping…");
  try {
    await sendToSidecar(jobId, { type: "abort_turn" });
  } catch {
    await cancelSidecar(jobId).catch(() => undefined);
  }
}

/** Starts over, or switches to a saved chat (Phase 8a): ends the job and shows `next` or nothing. The
 * next message starts a new job with `next`'s history, as after any ended job. */
export async function newConversation(next?: SavedChat): Promise<void> {
  const { jobId, status } = useAgentStore.getState();
  if (status === "thinking" || status === "stopping") return;
  if (jobId) await sendToSidecar(jobId, { type: "end_session" }).catch(() => cancelSidecar(jobId).catch(() => undefined));
  context = null;
  liveReplyId = null;
  useAgentStore.getState().endSession();
  if (next) useAgentStore.getState().loadChat(next);
  else useAgentStore.getState().clear();
}

/**
 * Runs one tool call for the running chat job's turn: under its context (so edits join its backup and
 * Revert group), with its transcript line, and refused once Stop was pressed. Also how a chat job's
 * calls that arrive through the MCP bridge are run (Phase 7b). Null: `jobId` isn't the running job.
 */
export async function runChatTool(jobId: string, name: string, args: unknown): Promise<ToolOutcome | null> {
  if (useAgentStore.getState().jobId !== jobId) return null;
  const executors = context ? executorsFor(context) : {};
  const stopping = useAgentStore.getState().status === "stopping";
  useAgentStore.getState().setActivity(`Running ${name}…`);
  const outcome = stopping
    ? { summary: "", result: { error: "Stopped by the user before this ran" } }
    : await runTool(executors, name, args);
  if (outcome.summary) useAgentStore.getState().addMessage({ role: "tool", text: outcome.summary });
  if (useAgentStore.getState().jobId === jobId && useAgentStore.getState().status === "thinking") {
    useAgentStore.getState().setActivity(`Calling ${PROVIDER_LABEL[provider]}…`);
  }
  return outcome;
}

async function answerToolCalls(jobId: string, calls: ToolCall[]): Promise<void> {
  for (const call of calls) {
    const outcome = await runChatTool(jobId, call.name, call.args);
    if (!outcome) return;
    try {
      await sendToSidecar(jobId, { type: "tool_result", id: call.id, result: outcome.result });
    } catch (error) {
      // The sidecar died between asking and now: the turn can't continue.
      useAgentStore.getState().addMessage({
        role: "error",
        text: `Lost the connection to the agent while reporting ${call.name}: ${describeError(error)}. Send another message to continue.`,
      });
      await cancelSidecar(jobId).catch(() => undefined);
      sessionEnded();
      return;
    }
  }
}

/** Routes the chat job's events into the agent store. Call once for the app's lifetime. */
export function startAgentService(): () => void {
  let stopped = false;
  const unlisteners: (() => void)[] = [];
  const keep = (promise: Promise<() => void>) =>
    promise.then((unlisten) => (stopped ? unlisten() : unlisteners.push(unlisten))).catch(() => undefined);

  keep(
    onSidecarEvent(({ jobId, event }) => {
      const store = useAgentStore.getState();
      if (!store.jobId || jobId !== store.jobId) return;
      switch (event.type) {
        case "reply_delta":
          if (typeof event.text !== "string" || !event.text) break;
          if (liveReplyId && store.messages.some((m) => m.id === liveReplyId)) store.appendToMessage(liveReplyId, event.text);
          else liveReplyId = store.addMessage({ role: "assistant", text: event.text, status: "pending" });
          break;
        case "reply_break":
          settleLiveReply();
          break;
        case "reply_reset":
          if (liveReplyId) store.removeMessage(liveReplyId);
          liveReplyId = null;
          break;
        case "tool_calls":
          if (Array.isArray(event.calls)) void answerToolCalls(jobId, event.calls as ToolCall[]);
          break;
        case "status":
          if (typeof event.detail === "string" && event.detail) store.setActivity(event.detail);
          break;
        case "retry": {
          const reason = typeof event.reason === "string" ? `: ${event.reason}` : "";
          const attempt = typeof event.attempt === "number" && typeof event.maxAttempts === "number" ? ` (attempt ${event.attempt} of ${event.maxAttempts})` : "";
          store.addMessage({ role: "tool", text: `Retrying with ${PROVIDER_LABEL[provider]}${attempt}${reason}…` });
          break;
        }
        case "result": {
          const text = typeof event.text === "string" ? event.text : "";
          if (event.aborted === true) {
            // What was written before Stop stays as it is; the stop notice follows.
            settleLiveReply();
            store.addMessage({ role: "error", text: "Stopped." });
            if (text) store.addMessage({ role: "assistant", text });
          } else if (liveReplyId && store.messages.some((m) => m.id === liveReplyId)) {
            // The result's text is the final answer: it replaces what was streamed.
            if (text) store.updateMessage(liveReplyId, { text, status: "done" });
            else settleLiveReply();
            liveReplyId = null;
          } else if (text) {
            store.addMessage({ role: "assistant", text });
          }
          if (event.outOfSteps === true) {
            store.addMessage({ role: "tool", text: "The agent used its step budget for this message; send another to continue." });
          }
          store.finishTurn(Array.isArray(event.history) ? event.history : store.history, provider, parseUsage(event.usage));
          endTurn();
          break;
        }
        case "error": {
          // The sidecar exits right after a genuine failure; nothing more follows on this job.
          settleLiveReply();
          store.addMessage({ role: "error", text: typeof event.message === "string" ? event.message : "The agent reported an error" });
          sessionEnded();
          break;
        }
        default:
          break;
      }
    }),
  );

  keep(
    onSidecarExit((exit) => {
      const store = useAgentStore.getState();
      if (!store.jobId || exit.jobId !== store.jobId) return;
      const running = store.status === "thinking" || store.status === "stopping";
      settleLiveReply();
      if (running) store.addMessage({ role: "error", text: exit.cancelled ? "Stopped." : (exit.message ?? "The agent stopped unexpectedly") });
      // Otherwise a quiet end between turns (idle timeout, end_session): nothing to say.
      sessionEnded();
    }),
  );

  return () => {
    stopped = true;
    unlisteners.splice(0).forEach((fn) => fn());
  };
}
