/**
 * The app's side of the MCP bridge (PLAN.md, Phase 7a). Rust (mcp_bridge.rs) hands over each checked
 * request from the shim (vibecut_agent/mcp_server.py) as `mcp-request`; this answers it with the
 * agent's own tools and writes the reply back through `mcp_reply`.
 *
 * - `list_tools`: the connected editor's tool declarations (the in-app chat's own), plus
 *   `get_editor_context` and `get_instructions` for clients that get neither from us.
 * - `call_tool` from the running chat job (7b): run as part of that turn (`runChatTool`).
 * - `call_tool` from outside (7d): run on the timeline open now, one call at a time. Edits are grouped
 *   into an "outside" step, so one Revert undoes a run. While an in-app turn is running, outside calls
 *   that change anything are refused; reads go through.
 * - A timeline an outside call moved to (create_timeline, switch_timeline, a send) is used by the next
 *   outside calls until the editor's watcher reports a change (PLAN.md, "19a"): each call reads the
 *   open timeline from the store, which lags a timeline made a moment ago.
 */
import { getMcpStatus, mcpHold, mcpReply, onMcpOutside, onMcpRequest } from "../ipc";
import { newId } from "../id";
import { refreshAgentStatus } from "../agent/availability";
import { describeError, snapshotFor } from "../agent/context";
import { runChatTool, withImagesKept } from "../agent/controller";
import type { ToolOutcome } from "../agent/args";
import { systemInstruction } from "../agent/prompt";
import { executorsFor, runTool, toolDeclarations, type ToolDeclaration } from "../agent/tools";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { OUTSIDE_CALLER, type McpReply, type McpRequest } from "../../types/mcp";
import { NLE_LABELS, type NleHost } from "../../types/nle";

/** A pause this long between outside calls starts a new outside step (a new Revert group). */
export const OUTSIDE_STEP_GAP_MS = 2 * 60_000;
/** How long a timeline an outside call moved to is kept while the watcher hasn't reported a change. */
export const MOVED_TIMELINE_MS = 30_000;
export const OUTSIDE_LABEL = "Claude Code (outside)";

const CONTEXT_TOOL = "get_editor_context";
const INSTRUCTIONS_TOOL = "get_instructions";
const NO_EDITOR =
  "No editor is connected to VibeCut Agent. Ask the user to open Premiere Pro (with the VibeCut Agent panel, Window → Extensions) or DaVinci Resolve, with a project and a timeline open.";

const CONTEXT_DECLARATION: ToolDeclaration = {
  name: CONTEXT_TOOL,
  description:
    "What VibeCut Agent sees right now: the connected editor, the open timeline with its clips and markers, any open draft, the project's media pool and the direct edits made so far (with ids for revert_timeline_edits). Call it before editing and whenever the user may have changed something.",
  parameters: { type: "OBJECT", properties: {} },
};
const INSTRUCTIONS_DECLARATION: ToolDeclaration = {
  name: INSTRUCTIONS_TOOL,
  description: "VibeCut Agent's editing rules for the connected editor: how its tools behave and what to check before an edit. Call it once at the start.",
  parameters: { type: "OBJECT", properties: {} },
};

/** Tools that only read: allowed from outside even while the in-app chat is running. */
export function isReadTool(name: string): boolean {
  return name === CONTEXT_TOOL || name === INSTRUCTIONS_TOOL || /^(list|get|find|describe|search|look_at|measure|review)_/.test(name);
}

/** The timeline the last outside call moved to, and the store's timeline then. */
let moved: { host: NleHost; timeline: string; reported: string | null; at: number } | null = null;

/** For tests. */
export function forgetMovedTimeline(): void {
  moved = null;
}

function activeEditor(): { host: NleHost; timeline: string | null } | null {
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  if (!host) return null;
  const state = nle.hosts[host];
  // Kept until the watcher reports another open timeline (the new one, or one the user opened since). A
  // state for another reason (the list of timelines grew) can come first, so only the name counts.
  const pending = moved && moved.host === host && state.timeline === moved.reported && Date.now() - moved.at < MOVED_TIMELINE_MS;
  if (!pending) moved = null;
  return { host, timeline: pending ? moved!.timeline : state.timeline };
}

export function listTools(): McpReply {
  const editor = activeEditor();
  const tools = editor ? [...toolDeclarations(editor.host), CONTEXT_DECLARATION, INSTRUCTIONS_DECLARATION] : [CONTEXT_DECLARATION];
  return { ok: true, result: { editor: editor?.host ?? null, tools } };
}

/** The two MCP-only tools; null for any other name. */
async function bridgeTool(name: string): Promise<McpReply | null> {
  if (name !== CONTEXT_TOOL && name !== INSTRUCTIONS_TOOL) return null;
  const editor = activeEditor();
  if (!editor) return { ok: true, result: { editor: null, context: NO_EDITOR } };
  if (name === INSTRUCTIONS_TOOL) return { ok: true, result: { editor: editor.host, instructions: systemInstruction(editor.host) } };
  const context = await snapshotFor(editor.host, editor.timeline);
  return { ok: true, result: { editor: editor.host, editorName: NLE_LABELS[editor.host], context } };
}

/** The outside step to log this call's edits under: the current one, or a new one after a pause. */
function outsideStep(now: number): string {
  const store = useMcpStore.getState();
  const current = store.outsideStep;
  const id = current && now - current.lastAt < OUTSIDE_STEP_GAP_MS ? current.id : `outside-${newId()}`;
  store.setOutsideStep({ id, lastAt: now });
  return id;
}

async function callOutside(name: string, args: Record<string, unknown>): Promise<McpReply> {
  const agent = useAgentStore.getState();
  if ((agent.status === "thinking" || agent.status === "stopping") && !isReadTool(name)) {
    return { ok: false, error: "VibeCut Agent's own chat is working on the timeline. Try again when it finishes." };
  }
  const editor = activeEditor();
  if (!editor) return { ok: false, error: NO_EDITOR };
  const context = { host: editor.host, timeline: editor.timeline, step: outsideStep(Date.now()), stepText: OUTSIDE_LABEL };
  const outcome = withImagesKept(await runTool(executorsFor(context), name, args), name, context.step);
  if (context.timeline && context.timeline !== editor.timeline) {
    moved = { host: editor.host, timeline: context.timeline, reported: useNleStateStore.getState().hosts[editor.host].timeline, at: Date.now() };
  }
  if (outcome.summary) agent.addMessage({ role: "tool", text: `${OUTSIDE_LABEL}: ${outcome.summary}` });
  return { ok: true, result: outcome.result, summary: outcome.summary, ...imagesOf(outcome) };
}

/** A tool's images as the MCP shim passes them on (Phase 13b). */
function imagesOf(outcome: ToolOutcome): { images?: { mime: string; data: string }[] } {
  return outcome.images?.length ? { images: outcome.images.map(({ mime, data }) => ({ mime, data })) } : {};
}

/** Outside calls run one at a time, in the order they arrived, like the chat's own. */
let outsideQueue: Promise<unknown> = Promise.resolve();

function queuedOutside(name: string, args: Record<string, unknown>): Promise<McpReply> {
  const store = useMcpStore.getState();
  store.outsideStarted();
  const run = outsideQueue.then(async () => {
    try {
      return (await bridgeTool(name)) ?? (await callOutside(name, args));
    } finally {
      useMcpStore.getState().outsideFinished();
      refreshAgentStatus();
    }
  });
  outsideQueue = run.catch(() => undefined);
  return run;
}

export async function handleRequest(request: McpRequest): Promise<McpReply> {
  try {
    if (request.kind === "list_tools") return listTools();
    const name = request.name ?? "";
    const args = request.args ?? {};
    if (request.caller === OUTSIDE_CALLER) return await queuedOutside(name, args);
    const bridged = await bridgeTool(name);
    if (bridged) return bridged;
    // A change waiting for review (Phase 11d): the shim lets this call wait for the user.
    const outcome = await runChatTool(request.caller, name, args, () => void mcpHold(request.id).catch(() => undefined));
    if (!outcome) return { ok: false, error: "That VibeCut Agent chat has ended." };
    return { ok: true, result: outcome.result, summary: outcome.summary, ...imagesOf(outcome) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** Answers the bridge's requests and keeps the store's Allow state current. Call once for the app's lifetime. */
export function startMcpBridge(): () => void {
  let stopped = false;
  const unlisteners: (() => void)[] = [];
  const keep = (promise: Promise<() => void>) =>
    promise.then((unlisten) => (stopped ? unlisten() : unlisteners.push(unlisten))).catch(() => undefined);

  getMcpStatus()
    .then((status) => useMcpStore.getState().setStatus(status.outsideAllowed, status.lastOutsideAt))
    .catch(() => undefined);
  keep(onMcpOutside((status) => useMcpStore.getState().setStatus(status.outsideAllowed, status.lastOutsideAt)));
  keep(
    onMcpRequest((request) => {
      void handleRequest(request).then((reply) => mcpReply(request.id, reply).catch(() => undefined));
    }),
  );

  return () => {
    stopped = true;
    unlisteners.splice(0).forEach((fn) => fn());
  };
}
