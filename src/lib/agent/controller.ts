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
import { MAX_IMAGES, attachmentOf, loadImages, saveImages } from "./attachments";
import { systemInstruction } from "./prompt";
import { executorsFor, runTool, toolDeclarations, type ToolContext } from "./tools";
import type { ToolOutcome } from "./args";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import type { ChatProvider, ChatUsage, PendingImage } from "../../types/agent";
import { AI_CHOICES, familyOf, type AiChoiceId } from "../../types/agent";
import type { PlanLimits, PlanWindow } from "../../types/usage";
import { useUsageStore } from "../../store/useUsageStore";
import type { SavedChat } from "../../types/history";

/** How much of a call's arguments, and of its result, a card keeps (and the saved chat with it). */
export const TOOL_DETAIL_CHARS = 4000;

const PROVIDER_LABEL: Record<ChatProvider, string> = { gemini: "Gemini", claude: "Claude", "claude-code": "Claude (subscription)" };

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** What the current job's tools act on and how it was started; set when a turn begins. */
let context: ToolContext | null = null;
let provider: ChatProvider = "gemini";
/** The model the running turn was sent to, for the usage tracker (Phase 9b). */
let turnChoice: AiChoiceId | null = null;
/** The assistant message the reply is streaming into, if one is. */
let liveReplyId: string | null = null;

export function parseUsage(value: unknown): ChatUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const n = (key: string) => (typeof v[key] === "number" ? (v[key] as number) : 0);
  return {
    promptTokens: n("promptTokens"),
    cachedTokens: n("cachedTokens"),
    outputTokens: n("outputTokens"),
    thoughtsTokens: n("thoughtsTokens"),
    steps: n("steps"),
    ...(typeof v.costUsd === "number" ? { costUsd: v.costUsd } : {}),
  };
}

/** A `rate_limit` event's limits (claude_code_chat.plan_limits), checked field by field. */
export function parsePlanLimits(value: unknown): PlanLimits | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const windowOf = (raw: unknown): PlanWindow | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const w = raw as Record<string, unknown>;
    if (typeof w.used !== "number") return undefined;
    return { used: w.used, ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}) };
  };
  const limits: PlanLimits = {};
  if (typeof v.status === "string") limits.status = v.status;
  if (typeof v.limiting === "string") limits.limiting = v.limiting;
  for (const name of ["fiveHour", "weekly", "weeklyOverage"] as const) {
    const window = windowOf(v[name]);
    if (window) limits[name] = window;
  }
  return Object.keys(limits).length ? limits : null;
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

/** What an image sent without words says in the transcript (and to the model). */
export function imageOnlyText(count: number): string {
  return count === 1 ? "(image)" : "(images)";
}

/**
 * Sends one user message to the agent, with any images (Phase 8g: filed beside the chat first). Does
 * nothing unless the agent is idle. True when it was sent.
 */
export async function sendUserMessage(text: string, images: PendingImage[] = []): Promise<boolean> {
  const store = useAgentStore.getState();
  const words = text.trim() || (images.length ? imageOnlyText(images.length) : "");
  // An outside client (MCP, Phase 7a) is editing: one driver at a time. The composer says so too.
  if (!words || images.length > MAX_IMAGES || store.status !== "idle" || useMcpStore.getState().outsideRunning > 0) return false;
  store.setStatus("thinking");
  if (images.length) {
    store.setActivity("Saving the images…");
    try {
      await saveImages(store.chatId, images);
    } catch (error) {
      useAgentStore.getState().setActivity(null);
      useAgentStore.getState().addMessage({ role: "error", text: `Couldn't keep the image${images.length === 1 ? "" : "s"} to send: ${describeError(error)}` });
      endTurn();
      return false;
    }
  }
  const step = useAgentStore.getState().addMessage({
    role: "user",
    text: words,
    status: "done",
    ...(images.length ? { attachments: images.map(attachmentOf) } : {}),
  });
  useAgentStore.getState().setActivity("Reading the timeline…");

  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  const timeline = host ? nle.hosts[host].timeline : null;
  const choice = AI_CHOICES.find((c) => c.id === store.aiChoice) ?? AI_CHOICES[0];
  const userMessage = `${await snapshotFor(host, timeline)}\n\n${words}`;
  // Settings' effort for this Claude model (Phase 9a). A change starts a new job, like a model switch.
  const family = familyOf(choice);
  const effort = family ? store.effort[family] : null;
  const key = `${choice.id}:${effort ?? "-"}:${host ?? "none"}`;
  context = host ? { host, timeline, step, stepText: words } : null;
  provider = choice.chatProvider;
  turnChoice = choice.id;
  useAgentStore.getState().setActivity(`Calling ${PROVIDER_LABEL[provider]}…`);

  const current = useAgentStore.getState();
  const history = current.historyProvider === provider ? current.history : [];
  const attachments = images.length ? { attachments: images.map(({ mime, data }) => ({ mime, data })) } : {};
  // What Retry and Edit go back to (Phase 8c). Claude Code's turn forks its session, so this one stays.
  current.setLastTurn({ userMessageId: step, history, historyProvider: history.length ? provider : null });
  if (current.jobId && current.sessionKey === key) {
    try {
      await sendToSidecar(current.jobId, { type: "user_message", userMessage, history, ...attachments });
      return true;
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
      ...(effort ? { effort } : {}),
      systemInstruction: systemInstruction(host),
      toolDeclarations: host ? toolDeclarations(host) : [],
      history,
      userMessage,
      ...attachments,
    });
  } catch (error) {
    useAgentStore.getState().addMessage({ role: "error", text: describeError(error) });
    sessionEnded();
  }
  return true;
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

/** The last turn's user message, if it's still shown. */
function lastTurnMessage() {
  const store = useAgentStore.getState();
  return store.messages.find((m) => m.id === store.lastTurn?.userMessageId);
}

/** Puts the last message in the composer to be edited (Phase 8c), with its images (8g). False when it
 * can't be now. */
export function startEditingLastMessage(): boolean {
  if (rewindBlockReason()) return false;
  const store = useAgentStore.getState();
  const message = lastTurnMessage();
  if (!message) return false;
  const images = message.attachments ?? [];
  store.setDraft(images.length && message.text === imageOnlyText(images.length) ? "" : message.text);
  store.setPendingImages([]);
  store.setEditing(message.id);
  if (images.length) {
    const chatId = store.chatId;
    loadImages(chatId, images)
      .then((loaded) => {
        const now = useAgentStore.getState();
        if (now.editingMessageId === message.id && now.chatId === chatId) now.setPendingImages(loaded);
      })
      .catch((error: unknown) => useAgentStore.getState().addMessage({ role: "error", text: `Couldn't load that message's images: ${describeError(error)}` }));
  }
  return true;
}

/** Leaves editing; the composer empties. */
export function cancelEditing(): void {
  const store = useAgentStore.getState();
  if (!store.editingMessageId) return;
  store.setEditing(null);
  store.setDraft("");
  store.setPendingImages([]);
}

/** Retry: the last message again, with its images, from where it started. */
export async function retryLastTurn(): Promise<void> {
  // The images are read back first: if they can't be, nothing has been taken back yet.
  const images = await loadImages(useAgentStore.getState().chatId, lastTurnMessage()?.attachments);
  const text = await rewindLastTurn();
  await sendUserMessage(text, images);
}

/** Edit: the last message replaced with `text` and `images`, from where it started. */
export async function sendEditedMessage(text: string, images: PendingImage[] = []): Promise<void> {
  if (!text.trim() && !images.length) return;
  await rewindLastTurn();
  await sendUserMessage(text, images);
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
  if (stopping) return { summary: "", result: { error: "Stopped by the user before this ran" } };
  // The card shows while the call runs (Phase 8f), then takes its summary and result.
  const card = useAgentStore.getState().addMessage({ role: "tool", text: `Running ${name}…`, tool: { name, args: toolDetail(args), state: "running" } });
  const outcome = await runTool(executors, name, args);
  const failed = typeof outcome.result === "object" && outcome.result !== null && "error" in outcome.result;
  useAgentStore.getState().updateMessage(card, {
    text: outcome.summary || name,
    tool: { name, args: toolDetail(args), result: toolDetail(outcome.result), state: failed ? "failed" : "done" },
  });
  if (useAgentStore.getState().jobId === jobId && useAgentStore.getState().status === "thinking") {
    useAgentStore.getState().setActivity(`Calling ${PROVIDER_LABEL[provider]}…`);
  }
  return outcome;
}

/** A tool call's arguments or result as a card shows them: pretty JSON, cut to TOOL_DETAIL_CHARS. */
export function toolDetail(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= TOOL_DETAIL_CHARS) return text;
  return `${text.slice(0, TOOL_DETAIL_CHARS)}\n… (${(text.length - TOOL_DETAIL_CHARS).toLocaleString("en-US")} more characters not kept)`;
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
        case "rate_limit": {
          // The Claude plan's windows, as Claude Code saw them during the turn (Phase 9b).
          const limits = parsePlanLimits(event.limits);
          if (limits) useUsageStore.getState().setPlan(limits);
          break;
        }
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
          const usage = parseUsage(event.usage);
          if (usage && turnChoice) useUsageStore.getState().addTurn(turnChoice, store.chatId, usage);
          store.finishTurn(Array.isArray(event.history) ? event.history : store.history, provider, usage);
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
