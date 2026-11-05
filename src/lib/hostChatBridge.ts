/**
 * The app's side of the "VibeCut Agent" panels in Premiere Pro and DaVinci Resolve
 * (`vibecut.host.panels.v1`, docs/specs/host-panels-plan.md), after VibeCut's hostChatRelay.ts. For each
 * editor whose panel has run, it publishes the chat as `state.json` and the B-roll Library as
 * `broll.json` (lib/brollPanel.ts) whenever the stores change, writes the B-roll tab's thumbnails, and
 * answers the panel's actions with the same functions the app's own window uses. The panels and the
 * window show one conversation, so a message sent from any of them appears in all three. Since panel
 * 0.20.0 it also publishes the window's Analyze tab as `analyzer.json`, and `state.json` carries the
 * header's editor lights, the usage tracker and the last reply's timing.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildBrollFile, handleAction as handleBrollAction, wantedThumbs } from "./brollPanel";
import { cancelJob, exportSelectsXml, buildSelectsTimeline, placeAtPlayhead, placementTarget, startAnalysis, startMatch } from "./broll";
import { selectedPaths, selects, type Selects } from "./brollSelects";
import { refreshPlan } from "./agent/planRefresh";
import { describeTiming, useTurnTimingStore } from "./agent/turnTiming";
import { connectionDetail } from "./nleStatus";
import { lastTurnEdits, newConversation, resumeQueue, retryLastTurn, rewindBlockReason, sendEditedMessage, stopTurn, submitMessage } from "./agent/controller";
import { chatTitle, openChat } from "./agent/chatHistory";
import { discardDraft, sendDraft } from "./agent/draft";
import { revertLastRequest } from "./agent/edits";
import { answerReview } from "./agent/review";
import { nleCall, revealInFinder } from "./ipc";
import { openInSourceMonitor, openLibrary } from "./library";
import { count, HOST_SHORT } from "./agent/edits";
import { useAgentStore } from "../store/useAgentStore";
import { staleOptions, useBrollStore, type AnalyzerOptions } from "../store/useBrollStore";
import { etaSeconds, useSidecarStore } from "../store/useSidecarStore";
import { recentTotals, useUsageStore } from "../store/useUsageStore";
import { useChatHistoryStore } from "../store/useChatHistoryStore";
import { useConnectionStore } from "../store/useConnectionStore";
import { lastEditStep, useEditLogStore } from "../store/useEditLogStore";
import { useLibraryStore } from "../store/useLibraryStore";
import { useMcpStore } from "../store/useMcpStore";
import { selectActiveHost, useNleStateStore } from "../store/useNleStateStore";
import { usePromptStore } from "../store/usePromptStore";
import { AI_CHOICES, type ChatMessage } from "../types/agent";
import type { AnalyzeResult, MatchHit, MatchResult, RankedClip } from "../types/broll";
import type { PanelBrollFile } from "../types/brollPanel";
import {
  HOST_PANEL_VERSION,
  type HostAnalyzerClip,
  type HostAnalyzerFile,
  type HostAnalyzerList,
  type HostChatAction,
  type HostPanelJob,
  type HostPanelMessage,
  type HostPanelStateFile,
} from "../types/hostPanel";
import type { SidecarJob } from "../types/sidecar";
import { NLE_HOSTS, NLE_LABELS, type NleHost } from "../types/nle";

/** Coalesces bursts of store changes (a streaming reply) into one write per editor. */
const PUBLISH_DELAY_MS = 80;
/** How long to wait before trying an editor whose panel has never run again. */
const ABSENT_RETRY_MS = 2000;
/** What a panel gets of the chat, so `state.json` stays well under Rust's 4 MiB. */
export const MAX_PANEL_MESSAGES = 200;
export const MAX_PANEL_TEXT_CHARS = 20_000;
const MAX_PANEL_HISTORY = 100;
/** The Analyzer's ranked clips a panel gets: the best ones, as the window lists them. */
export const MAX_PANEL_CLIPS = 200;

/** Actions that work on an editor: they run on the editor whose panel sent them. */
const HOST_SCOPED = new Set<HostChatAction["type"]>([
  "send",
  "edit_last",
  "retry",
  "revert",
  "draft_send",
  "draft_discard",
  "set_playhead",
  "broll_import",
  "broll_source",
  "broll_place",
  "analyzer_place",
  "analyzer_source",
  "analyzer_build",
]);

/** Each editor's last answer to its panel, and the thumbnails in its folder. */
const notices: Partial<Record<NleHost, HostPanelStateFile["notice"]>> = {};
const analyzerNotices: Partial<Record<NleHost, HostAnalyzerFile["notice"]>> = {};
/** The Analyzer's export job, and the XML it last wrote (Show in Finder names only this). */
let exportJobId: string | null = null;
let lastExport: string | null = null;
const thumbs: Record<NleHost, Set<number>> = { premiere: new Set(), resolve: new Set() };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cut = (text: string) => (text.length > MAX_PANEL_TEXT_CHARS ? `${text.slice(0, MAX_PANEL_TEXT_CHARS)}…` : text);

// ----------------------------------------------------------------------------- what the panel gets

function panelMessage(m: ChatMessage): HostPanelMessage {
  return {
    id: m.id,
    role: m.role,
    text: cut(m.text),
    createdAt: m.createdAt,
    ...(m.status === "pending" ? { status: "pending" as const } : m.status ? { status: "done" as const } : {}),
    ...(m.tool
      ? {
          tool: {
            id: m.id,
            name: m.tool.name,
            summary: cut(m.text),
            args: m.tool.args,
            ...(m.tool.result !== undefined ? { result: m.tool.result } : {}),
            state: m.tool.state,
            ...(m.tool.findings ? { findings: m.tool.findings } : {}),
          },
        }
      : {}),
    ...(m.attachments?.length ? { imageCount: m.attachments.length } : {}),
  };
}

/** `state.json` for `host`'s panel as the app is now. */
export function buildHostStateFile(host: NleHost, now = Date.now()): HostPanelStateFile {
  const agent = useAgentStore.getState();
  const editor = useNleStateStore.getState().hosts[host];
  const entries = useEditLogStore.getState().entries;
  const draft = useConnectionStore.getState().connections[host].draft;
  const chats = useChatHistoryStore.getState().chats ?? [];
  const broll = buildBrollFile(now, host, thumbs[host]).editor;
  const step = lastEditStep(entries);
  const rewindBlocked = rewindBlockReason();
  const connected = editor.status === "connected";
  return {
    version: HOST_PANEL_VERSION,
    publishedAt: now,
    host,
    editor: {
      connected,
      status: editor.status,
      product: editor.product,
      version: editor.version,
      project: editor.project,
      timeline: editor.timeline,
      timelines: editor.timelines,
      noEditor: connected ? null : (editor.message ?? `VibeCut Agent isn't connected to ${NLE_LABELS[host]}`),
      noPlace: broll.noPlace,
    },
    editors: NLE_HOSTS.map((h) => {
      const state = useNleStateStore.getState().hosts[h];
      return { host: h, status: state.status, detail: connectionDetail(state) };
    }),
    usage: usageFile(agent.chatId, now),
    agent: {
      status: agent.status,
      statusDetail: agent.statusDetail,
      activity: agent.activity,
      aiChoice: agent.aiChoice,
      choices: AI_CHOICES.map((c) => ({ id: c.id, label: c.label })),
      effort: agent.effort,
      geminiEffort: agent.geminiEffort,
      reviewEdits: agent.reviewEdits,
      outsideRunning: useMcpStore.getState().outsideRunning > 0,
      lastReply: (() => {
        const last = useTurnTimingStore.getState().last;
        return last ? describeTiming(last) || null : null;
      })(),
    },
    chat: {
      chatId: agent.chatId,
      title: agent.customTitle || agent.autoTitle || chatTitle(agent.messages),
      messages: agent.messages.slice(-MAX_PANEL_MESSAGES).map(panelMessage),
      queue: agent.queue.map((q) => ({ id: q.id, text: cut(q.text), imageCount: q.images.length })),
      queuePaused: agent.queuePaused,
      canRetry: Boolean(agent.lastTurn) && agent.status === "idle" && !rewindBlocked,
      rewindBlocked,
      lastTurnEdits: lastTurnEdits().length,
      revertable: step.length,
      earlierSessionRevert: step.length > 0 && entries.some((e) => e.id === step[0] && e.fromEarlierRun),
    },
    openDraft: draft ? { base: draft.base, changes: draft.changes, duration: draft.duration } : null,
    history: chats.slice(0, MAX_PANEL_HISTORY).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messageCount })),
    prompts: usePromptStore.getState().prompts.map((p) => ({ id: p.id, name: p.name, body: p.body })),
    notice: notices[host] ?? null,
  };
}

/** The usage tracker's numbers, as the window's UsageMeter reads them. */
function usageFile(chatId: string, now: number): HostPanelStateFile["usage"] {
  const { plan, planAt, days, chats } = useUsageStore.getState();
  const chat = chats[chatId];
  return {
    plan,
    planAt,
    chat: chat ? { turns: chat.turns, promptTokens: chat.promptTokens, cachedTokens: chat.cachedTokens, outputTokens: chat.outputTokens, costUsd: chat.costUsd } : null,
    today: recentTotals(days, 1, now),
    week: recentTotals(days, 7, now),
    labels: AI_CHOICES.map((c) => ({ id: c.id, label: c.label, subscription: c.provider === "claude-code" })),
  };
}

/** `broll.json` for `host`'s panel: the B-roll Library, with that editor's status. */
export function buildHostBrollFile(host: NleHost, now = Date.now()): PanelBrollFile {
  return buildBrollFile(now, host, thumbs[host]);
}

// ----------------------------------------------------------------------------- the Analyze tab

function panelJob(id: string | null): HostPanelJob | null {
  const job: SidecarJob | undefined = id ? useSidecarStore.getState().jobs.find((j) => j.id === id) : undefined;
  if (!job) return null;
  return { label: job.label, status: job.status, fraction: job.fraction, detail: job.detail ?? job.phase, eta: etaSeconds(job, Date.now()), error: job.error };
}

/** The analysis the window shows now: this run's while it's fresh, else the kept one for this folder. */
function currentAnalysis(): AnalyzeResult | null {
  const s = useBrollStore.getState();
  const job = s.analyzeJobId ? useSidecarStore.getState().jobs.find((j) => j.id === s.analyzeJobId) : undefined;
  const live = job?.result as AnalyzeResult | undefined;
  if (live && Array.isArray(live.ranked)) return live;
  return s.lastResult && s.lastResult.folder === s.folder ? s.lastResult.result : null;
}

function currentMatches(): MatchHit[] {
  const s = useBrollStore.getState();
  const job = s.matchJobId ? useSidecarStore.getState().jobs.find((j) => j.id === s.matchJobId) : undefined;
  return (job?.result as MatchResult | undefined)?.matches?.[0]?.results ?? [];
}

const selectOptions = (s: AnalyzerOptions) => ({ topMode: s.topMode, topN: s.topN, minScore: s.minScore, sequenceOrder: s.sequenceOrder });

/** The selects as the window's SelectsBar has them: ticked segments of the clips the Include setting keeps. */
function currentSelects(): Selects | null {
  const analysis = currentAnalysis();
  if (!analysis) return null;
  const s = useBrollStore.getState();
  return selects(analysis.ranked, selectOptions(s), s.excluded, true);
}

/** Why the selects can't be built in `host` now, or null. */
function buildBlockedIn(host: NleHost): string | null {
  if (useNleStateStore.getState().hosts[host].status !== "connected") return `Connect ${HOST_SHORT[host]} to build a timeline`;
  if (useConnectionStore.getState().connections[host].draft) return `A Story Editor draft is open in ${HOST_SHORT[host]}; send or discard it first`;
  return null;
}

function rankedClip(clip: RankedClip, excluded: number[], inSelection: boolean): HostAnalyzerClip {
  return {
    filename: clip.filename,
    score: clip.score,
    start: clip.bestStart,
    end: clip.bestEnd,
    duration: clip.duration,
    segments: clip.segments.map((g) => ({ start: g.start, end: g.end, score: g.score })),
    excluded,
    inSelection,
    chips: [clip.energy === null ? null : `energy ${Math.round(clip.energy)}`, clip.relevance === null ? null : `brief ${Math.round(clip.relevance)}`].filter((c): c is string => c !== null),
    note: clip.duplicateOf ? `Near-duplicate of ${clip.duplicateOf.split("/").pop()}` : null,
  };
}

function matchClip(hit: MatchHit): HostAnalyzerClip {
  return {
    filename: hit.filename,
    score: hit.combined,
    start: hit.start,
    end: hit.end,
    duration: hit.duration,
    segments: [{ start: hit.start, end: hit.end }],
    chips: [`match ${Math.round(hit.relative)}`, ...(hit.technical === null ? [] : [`quality ${Math.round(hit.technical)}`])],
    note: null,
  };
}

/** `analyzer.json` for `host`'s panel: the window's Analyze tab, with that editor's Place and Build. */
export function buildHostAnalyzerFile(host: NleHost, now = Date.now()): HostAnalyzerFile {
  const s = useBrollStore.getState();
  const analysis = currentAnalysis();
  const ranked = analysis?.ranked ?? [];
  const inSelection = selectedPaths(ranked, selectOptions(s), true);
  const chosen = currentSelects();
  const target = placementTarget(host);
  const analyzing = panelJob(s.analyzeJobId);
  return {
    version: HOST_PANEL_VERSION,
    publishedAt: now,
    folder: s.folder,
    contentAware: s.contentAware,
    dedupe: s.dedupe,
    brief: s.brief,
    query: s.query,
    options: {
      windowSec: s.windowSec,
      maxSegments: s.maxSegments,
      minGapSec: s.minGapSec,
      energyWeight: s.energyWeight,
      relevanceWeight: s.relevanceWeight,
      workers: s.workers,
      topMode: s.topMode,
      topN: s.topN,
      minScore: s.minScore,
      sequenceOrder: s.sequenceOrder,
      sequenceName: s.sequenceName,
    },
    analyzeJob: analyzing,
    matchJob: panelJob(s.matchJobId),
    exportJob: panelJob(exportJobId),
    analysis: analysis
      ? {
          total: ranked.length,
          cached: analysis.cached,
          duplicates: analysis.duplicates,
          issues: [...analysis.warnings, ...analysis.failed.map((f) => `${f.path.split("/").pop()}: ${f.message}`)],
          stale: analyzing && (analyzing.status === "starting" || analyzing.status === "running") ? [] : staleOptions(s),
          ranked: ranked.slice(0, MAX_PANEL_CLIPS).map((c) => rankedClip(c, s.excluded[c.path] ?? [], inSelection.has(c.path))),
        }
      : null,
    matches: currentMatches().map(matchClip),
    selects: chosen ? { segments: chosen.segments, clips: chosen.clips.length, seconds: chosen.seconds } : null,
    buildBlocked: buildBlockedIn(host),
    placeBlocked: typeof target === "string" ? target : null,
    notice: analyzerNotices[host] ?? null,
  };
}

/** The clip an Analyzer action names by its place in the panel's list, or why there's none. */
function namedClip(list: HostAnalyzerList, index: number): { path: string; filename: string; segments: { start: number; end: number }[] } {
  if (list === "ranked") {
    const clip = currentAnalysis()?.ranked[index];
    if (!clip || index >= MAX_PANEL_CLIPS) throw new Error("That clip isn't in the Analyzer's list any more");
    return { path: clip.path, filename: clip.filename, segments: clip.segments.length ? clip.segments : [{ start: clip.bestStart, end: clip.bestEnd }] };
  }
  const hit = currentMatches()[index];
  if (!hit) throw new Error("That search result isn't there any more");
  return { path: hit.path, filename: hit.filename, segments: [{ start: hit.start, end: hit.end }] };
}

const segmentOf = (clip: { segments: { start: number; end: number }[] }, index: number) => clip.segments[index] ?? clip.segments[0];

const exportStamp = (now = new Date()) => {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
};

const analyzerSay = (actionId: string | null, host: NleHost, text: string, failed: boolean, exported = false) => {
  analyzerNotices[host] = { actionId, text, failed, at: Date.now(), exported };
};

/** The Analyze tab's actions, with the window's own functions (lib/broll.ts). */
type AnalyzerAction = Extract<HostChatAction, { type: `analyzer_${string}` }>;

async function runAnalyzer(host: NleHost, action: AnalyzerAction): Promise<void> {
  const store = useBrollStore.getState();
  const running = (id: string | null) => {
    const job = panelJob(id);
    return !!job && (job.status === "starting" || job.status === "running");
  };
  switch (action.type) {
    case "analyzer_set_folder":
      if (running(store.analyzeJobId) || running(store.matchJobId)) return analyzerSay(action.id, host, "Wait for the running analysis or search to finish", true);
      return store.setFolder(action.path);
    case "analyzer_set_option":
      if (running(store.analyzeJobId)) return analyzerSay(action.id, host, "The options wait until the analysis finishes", true);
      if (action.key === "contentAware") return store.setContentAware(action.value);
      if (action.key === "dedupe") return store.setDedupe(action.value);
      if (action.key === "brief") return store.setBrief(action.value);
      return store.setOption(action.key, action.value as never);
    case "analyzer_reset_options":
      return store.resetOptions();
    case "analyzer_start":
      if (!store.folder) return analyzerSay(action.id, host, "Choose a folder first", true);
      if (running(store.analyzeJobId)) return;
      return startAnalysis();
    case "analyzer_cancel":
      for (const id of [store.analyzeJobId, store.matchJobId, exportJobId]) if (id && running(id)) await cancelJob(id);
      return;
    case "analyzer_match":
      if (!store.contentAware) return analyzerSay(action.id, host, "Search needs content-aware scoring", true);
      store.setQuery(action.query);
      return startMatch();
    case "analyzer_toggle_segment": {
      const clip = namedClip("ranked", action.clip);
      if (action.segment < clip.segments.length) store.toggleSegment(clip.path, action.segment);
      return;
    }
    case "analyzer_place": {
      const clip = namedClip(action.list, action.clip);
      const segment = segmentOf(clip, action.segment);
      return analyzerSay(action.id, host, await placeAtPlayhead({ path: clip.path, filename: clip.filename, start: segment.start, end: segment.end }, { host }), false);
    }
    case "analyzer_source": {
      const clip = namedClip(action.list, action.clip);
      const segment = segmentOf(clip, action.segment);
      if (useNleStateStore.getState().hosts[host].status !== "connected") throw new Error(`Connect ${HOST_SHORT[host]} first`);
      return analyzerSay(action.id, host, await openInSourceMonitor(host, { path: clip.path, filename: clip.filename, start: segment.start, end: segment.end }), false);
    }
    case "analyzer_reveal":
      return revealInFinder(namedClip(action.list, action.clip).path);
    case "analyzer_export": {
      const chosen = currentSelects();
      if (!store.folder || !chosen?.clips.length) return analyzerSay(action.id, host, "No segments are selected.", true);
      const name = store.folder.split("/").filter(Boolean).pop() ?? "B-roll";
      // The panel has no save dialog: the XML goes beside the footage, named so it never replaces one.
      const done = await exportSelectsXml(chosen, (id) => (exportJobId = id), `${store.folder}/${name} selects ${exportStamp()}.xml`);
      if (!done) return;
      lastExport = done.path;
      return analyzerSay(action.id, host, `${done.text} Saved as ${done.path.split("/").pop()}.`, false, true);
    }
    case "analyzer_build": {
      const chosen = currentSelects();
      const blocked = buildBlockedIn(host);
      if (blocked) return analyzerSay(action.id, host, blocked, true);
      if (!chosen?.segments) return analyzerSay(action.id, host, "No segments are selected.", true);
      // Progress, not the answer: the panel keeps waiting for the build's own notice.
      analyzerSay(null, host, `Building ${count(chosen.segments, "segment")} in ${HOST_SHORT[host]}…`, false);
      return analyzerSay(action.id, host, await buildSelectsTimeline(chosen), false);
    }
    case "analyzer_reveal_export":
      if (lastExport) return revealInFinder(lastExport);
      return;
  }
}

// ----------------------------------------------------------------------------- the panel's actions

const say = (actionId: string, host: NleHost, text: string, failed: boolean) => {
  notices[host] = { actionId, text, failed, at: Date.now() };
};

/** A Revert or a draft's answer, shown in the chat as in the app's window, and as the panel's notice. */
async function reply(action: HostChatAction, host: NleHost, work: () => Promise<{ summary: string }>): Promise<void> {
  const outcome = await work();
  useAgentStore.getState().addMessage({ role: "tool", text: outcome.summary });
  say(action.id, host, outcome.summary, false);
}

async function run(host: NleHost, action: HostChatAction): Promise<void> {
  const agent = useAgentStore.getState();
  switch (action.type) {
    case "hello":
      return openLibrary();
    case "send": {
      const sent = await submitMessage(action.text);
      if (!sent) {
        const why = agent.status === "offline" || agent.status === "error" ? (agent.statusDetail ?? "The agent isn't running") : "The queue is full";
        say(action.id, host, `Not sent: ${why}`, true);
      }
      return;
    }
    case "stop":
      return stopTurn();
    case "new_chat":
      return newConversation();
    case "load_chat":
      return openChat(action.chatId);
    case "retry":
      return retryLastTurn();
    case "edit_last":
      return sendEditedMessage(action.text);
    case "revert":
      return reply(action, host, () => revertLastRequest({ byUser: true }));
    case "review_decision":
      if (!answerReview(action.cardId, action.decision)) say(action.id, host, "That change isn't waiting for review any more", true);
      return;
    case "set_model":
      return agent.setAiChoice(action.aiChoice);
    case "set_effort":
      return agent.setEffort(action.family, action.effort);
    case "set_gemini_effort":
      return agent.setGeminiEffort(action.effort);
    case "set_review_edits":
      return agent.setReviewEdits(action.on);
    case "queue_remove":
      return agent.removeQueued(action.queueId);
    case "queue_clear":
      return agent.clearQueue();
    case "queue_resume":
      return resumeQueue();
    case "draft_send": {
      const draft = useConnectionStore.getState().connections[host].draft;
      if (!draft) return say(action.id, host, "There's no open draft", true);
      return reply(action, host, () => sendDraft({ host, timeline: draft.base, step: "draft-bar", stepText: "" }));
    }
    case "draft_discard":
      return reply(action, host, async () => discardDraft(host));
    case "set_playhead": {
      const timeline = useNleStateStore.getState().hosts[host].timeline;
      await nleCall(host, "set_playhead", { timeline, time: action.seconds });
      return;
    }
    case "open_window":
      // Rust opened the window already (host_chat.rs).
      return;
    case "usage_refresh": {
      const problem = await refreshPlan();
      if (problem) say(action.id, host, problem, true);
      return;
    }
    case "analyzer_start":
    case "analyzer_cancel":
    case "analyzer_reset_options":
    case "analyzer_export":
    case "analyzer_build":
    case "analyzer_reveal_export":
    case "analyzer_set_folder":
    case "analyzer_set_option":
    case "analyzer_match":
    case "analyzer_toggle_segment":
    case "analyzer_place":
    case "analyzer_source":
    case "analyzer_reveal":
      return runAnalyzer(host, action);
    default:
      return handleBrollAction(action, host);
  }
}

/** Runs one action from `host`'s panel. A failure becomes the panel's notice (and, for a chat action,
 * an error in the chat). */
export async function handleHostChatAction(host: NleHost, action: HostChatAction): Promise<void> {
  if (HOST_SCOPED.has(action.type)) {
    // The turn and its tools work on the editor whose panel sent this.
    const nle = useNleStateStore.getState();
    if (nle.hosts[host].status === "connected" && selectActiveHost(nle) !== host) nle.setPreferredHost(host);
  }
  try {
    await run(host, action);
  } catch (error) {
    if (action.type.startsWith("analyzer_")) analyzerSay(action.id, host, describe(error), true);
    else say(action.id, host, describe(error), true);
    if (!action.type.startsWith("broll_") && !action.type.startsWith("analyzer_") && action.type !== "usage_refresh") useAgentStore.getState().addMessage({ role: "error", text: describe(error) });
  }
}

// ----------------------------------------------------------------------------- publishing

/** Keeps both editors' panel files up to date and answers their actions. Call once for the app's lifetime. */
export function startHostChatBridge(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const absentUntil: Record<NleHost, number> = { premiere: 0, resolve: 0 };
  /** The last file written for each editor, without its stamp, so an unchanged file isn't rewritten. */
  const written: Record<NleHost, { state: string; broll: string; analyzer: string }> = {
    premiere: { state: "", broll: "", analyzer: "" },
    resolve: { state: "", broll: "", analyzer: "" },
  };
  /** One action at a time per editor, in the order it sent them. */
  const queues: Record<NleHost, Promise<void>> = { premiere: Promise.resolve(), resolve: Promise.resolve() };

  const unstamped = (file: { publishedAt: number }) => JSON.stringify({ ...file, publishedAt: 0 });

  const publishHost = async (host: NleHost) => {
    if (Date.now() < absentUntil[host]) return;
    const now = Date.now();
    const state = buildHostStateFile(host, now);
    const stateKey = unstamped(state);
    if (stateKey !== written[host].state) {
      if (!(await invoke<boolean>("host_chat_publish", { host, state }))) {
        // The panel has never run in this editor: nothing is written, and it's tried again later.
        absentUntil[host] = Date.now() + ABSENT_RETRY_MS;
        return;
      }
      written[host].state = stateKey;
    }
    const analyzer = buildHostAnalyzerFile(host, now);
    const analyzerKey = unstamped(analyzer);
    if (analyzerKey !== written[host].analyzer && (await invoke<boolean>("host_chat_analyzer_publish", { host, file: analyzer }))) written[host].analyzer = analyzerKey;
    const broll = buildHostBrollFile(host, now);
    const brollKey = unstamped(broll);
    if (brollKey !== written[host].broll && (await invoke<boolean>("host_chat_broll_publish", { host, file: broll }))) {
      written[host].broll = brollKey;
      const wanted = wantedThumbs(thumbs[host]);
      if (wanted.length) {
        try {
          const ready = await invoke<number[]>("host_chat_thumbs", { host, shotIds: wanted });
          ready.forEach((id) => thumbs[host].add(id));
          if (ready.length) publish();
        } catch {
          // Pictures are a nicety: the cards show without them.
        }
      }
    }
  };

  const publish = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      for (const host of NLE_HOSTS) void publishHost(host).catch(() => undefined);
    }, PUBLISH_DELAY_MS);
  };

  const unsubscribe = [
    useAgentStore.subscribe(publish),
    useNleStateStore.subscribe(publish),
    useEditLogStore.subscribe(publish),
    useConnectionStore.subscribe(publish),
    useChatHistoryStore.subscribe(publish),
    useLibraryStore.subscribe(publish),
    useMcpStore.subscribe(publish),
    usePromptStore.subscribe(publish),
    useUsageStore.subscribe(publish),
    useTurnTimingStore.subscribe(publish),
    useBrollStore.subscribe(publish),
    useSidecarStore.subscribe(publish),
  ];
  const unlisten = listen<{ host: NleHost; action: HostChatAction | null; error: string | null; fileId: string }>("host-chat-action", ({ payload }) => {
    const { host } = payload;
    if (!NLE_HOSTS.includes(host)) return;
    // Its panel is open now, whatever its folder looked like before.
    absentUntil[host] = 0;
    const action = payload.action;
    if (!action) {
      if (payload.fileId) notices[host] = { actionId: payload.fileId, text: payload.error ?? "The panel's request was refused", failed: true, at: Date.now() };
      publish();
      return;
    }
    if (action.type === "hello") written[host] = { state: "", broll: "", analyzer: "" };
    queues[host] = queues[host].then(() => handleHostChatAction(host, action)).finally(publish);
  });
  publish();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe.forEach((fn) => fn());
    void unlisten.then((fn) => fn());
  };
}
