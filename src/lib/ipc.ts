/**
 * The only module that talks to Tauri. Commands live in `src-tauri/src/commands.rs`; the `navigate`
 * event comes from the tray (`src-tauri/src/tray.rs`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DependencyInfo, HwAccel, KeyProvider, KeyStatus, StoragePaths, View } from "../types/system";
import type {
  SessionStatus,
  SidecarCommand,
  SidecarEventPayload,
  SidecarExitPayload,
  SidecarInfo,
} from "../types/sidecar";
import type { NleHost, NleState, PremierePanelStatus } from "../types/nle";
import type { McpClientSetup, McpReply, McpRequest, McpStatus } from "../types/mcp";
import type { ClaudeCodeStatus } from "../types/agent";
import type { ChatSearchHit, ChatSummary, SavedChat, SavedEditLog } from "../types/history";

export const NAVIGATE_EVENT = "navigate";
export const SIDECAR_EVENT = "sidecar-event";
export const SIDECAR_EXIT_EVENT = "sidecar-exit";
export const SIDECAR_SESSION_EVENT = "sidecar-session";
export const NLE_STATE_EVENT = "nle-state";
export const KEEP_ON_TOP_EVENT = "keep-on-top";
export const MCP_REQUEST_EVENT = "mcp-request";
export const MCP_OUTSIDE_EVENT = "mcp-outside";
/** The agent session's job id (`SESSION_JOB_ID` in sidecar.rs). */
export const SESSION_JOB_ID = "agent-session";

export function takePendingView(): Promise<View | null> {
  return invoke<View | null>("take_pending_view");
}

export function getKeyStatus(): Promise<KeyStatus> {
  return invoke<KeyStatus>("llm_key_status");
}

/** Saves a provider's API key in the macOS Keychain. Rust checks it; the key is never sent back. */
export function setApiKey(provider: KeyProvider, key: string): Promise<KeyStatus> {
  return invoke<KeyStatus>("llm_key_set", { provider, key });
}

export function removeApiKey(provider: KeyProvider): Promise<KeyStatus> {
  return invoke<KeyStatus>("llm_key_remove", { provider });
}

export function getDependencyStatus(): Promise<DependencyInfo[]> {
  return invoke<DependencyInfo[]>("dependency_status");
}

export function getHardwareAcceleration(): Promise<HwAccel> {
  return invoke<HwAccel>("hardware_acceleration");
}

export function getStoragePaths(): Promise<StoragePaths> {
  return invoke<StoragePaths>("storage_paths");
}

export function getAppVersion(): Promise<string> {
  return getVersion();
}

export function onNavigate(handler: (view: View) => void): Promise<UnlistenFn> {
  return listen<View>(NAVIGATE_EVENT, (event) => handler(event.payload));
}

/**
 * Starts a one-shot sidecar job. The caller picks the job id so it can be listening before the first
 * event arrives. Rejects with a readable message if the job could not start.
 */
export function startSidecar(jobId: string, command: SidecarCommand, request: Record<string, unknown>): Promise<void> {
  return invoke("sidecar_start", { jobId, command, request });
}

/** Writes one JSON line to a running interactive job, such as the agent session. */
export function sendToSidecar(jobId: string, message: Record<string, unknown>): Promise<void> {
  return invoke("sidecar_send", { jobId, message });
}

/** Asks a job to stop. Does nothing if it has already ended. */
export function cancelSidecar(jobId: string): Promise<void> {
  return invoke("sidecar_cancel", { jobId });
}

export function getSessionStatus(): Promise<SessionStatus> {
  return invoke<SessionStatus>("sidecar_session_status");
}

export function restartSession(): Promise<void> {
  return invoke("sidecar_session_restart");
}

export function getSidecarInfo(): Promise<SidecarInfo> {
  return invoke<SidecarInfo>("sidecar_info");
}

export function onSidecarEvent(handler: (payload: SidecarEventPayload) => void): Promise<UnlistenFn> {
  return listen<SidecarEventPayload>(SIDECAR_EVENT, (event) => handler(event.payload));
}

export function onSidecarExit(handler: (payload: SidecarExitPayload) => void): Promise<UnlistenFn> {
  return listen<SidecarExitPayload>(SIDECAR_EXIT_EVENT, (event) => handler(event.payload));
}

export function onSessionStatus(handler: (status: SessionStatus) => void): Promise<UnlistenFn> {
  return listen<SessionStatus>(SIDECAR_SESSION_EVENT, (event) => handler(event.payload));
}

/** Both editors' current state (Rust `nle_state`). */
export function getNleState(): Promise<NleState[]> {
  return invoke<NleState[]>("nle_state");
}

/** Files an image sent with a message beside its chat (Phase 8g). `data` is base64. */
export function saveChatAttachment(chatId: string, attachmentId: string, mime: string, data: string): Promise<void> {
  return invoke("chat_attachment_save", { chatId, attachmentId, mime, data });
}

/** An image filed with `saveChatAttachment`. */
export function loadChatAttachment(chatId: string, attachmentId: string): Promise<{ mime: string; data: string }> {
  return invoke("chat_attachment_load", { chatId, attachmentId });
}

/** Opens an http(s) link from a reply in the default browser, never in the app's own window. */
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** One read from an editor through its watcher: `status` or `read_timeline` ({ timeline }). */
export function nleCall<T = unknown>(host: NleHost, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("nle_call", { host, command, args });
}

/** Restarts an editor's watcher now, clearing any backoff. */
export function nleReconnect(host: NleHost): Promise<void> {
  return invoke("nle_reconnect", { host });
}

export function onNleState(handler: (state: NleState) => void): Promise<UnlistenFn> {
  return listen<NleState>(NLE_STATE_EVENT, (event) => handler(event.payload));
}

export function getPremierePanelStatus(): Promise<PremierePanelStatus> {
  return invoke<PremierePanelStatus>("premiere_panel_status");
}

/** Copies VibeCut Agent's panel into Adobe's CEP extensions folder (only on the user's request). */
export function installPremierePanel(): Promise<PremierePanelStatus> {
  return invoke<PremierePanelStatus>("premiere_panel_install");
}

export function uninstallPremierePanel(): Promise<PremierePanelStatus> {
  return invoke<PremierePanelStatus>("premiere_panel_uninstall");
}

/** Asks the user for a folder; null if they cancelled. */
export async function chooseFolder(title: string, defaultPath?: string): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, title, ...(defaultPath ? { defaultPath } : {}) });
  return typeof picked === "string" ? picked : null;
}

/** Asks the user for one file with one of these extensions (none: any file); null if they cancelled. */
export async function chooseFile(title: string, extensions: string[], defaultPath?: string): Promise<string | null> {
  const filters = extensions.length ? { filters: [{ name: title, extensions }] } : {};
  const picked = await openDialog({ multiple: false, title, ...filters, ...(defaultPath ? { defaultPath } : {}) });
  return typeof picked === "string" ? picked : null;
}

/** Shows a file in Finder. */
export function revealInFinder(path: string): Promise<void> {
  return revealItemInDir(path);
}

/** Whether the window stays on top of other apps, including a full-screen editor (window_mode.rs). */
export function getKeepOnTop(): Promise<boolean> {
  return invoke<boolean>("keep_on_top_status");
}

export function setKeepOnTop(on: boolean): Promise<boolean> {
  return invoke<boolean>("set_keep_on_top", { on });
}

/** Every change, whichever control made it (the header, Settings or the tray). */
export function onKeepOnTop(handler: (on: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>(KEEP_ON_TOP_EVENT, (event) => handler(event.payload));
}

/** A request from the MCP shim (mcp_bridge.rs), already checked by Rust. */
export function onMcpRequest(handler: (request: McpRequest) => void): Promise<UnlistenFn> {
  return listen<McpRequest>(MCP_REQUEST_EVENT, (event) => handler(event.payload));
}

/** Answers an MCP request; Rust writes it where the shim waits for it. */
export function mcpReply(id: string, reply: McpReply): Promise<void> {
  return invoke("mcp_reply", { id, reply });
}

export function getMcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status");
}

/** Turns outside control (an MCP client the user started) on or off; saved by Rust. */
export function setMcpOutsideAllowed(on: boolean): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_set_outside_allowed", { on });
}

export function onMcpOutside(handler: (status: McpStatus) => void): Promise<UnlistenFn> {
  return listen<McpStatus>(MCP_OUTSIDE_EVENT, (event) => handler(event.payload));
}

/** How to register the MCP server with Claude Code, with this build's paths. */
export function getMcpClientSetup(): Promise<McpClientSetup> {
  return invoke<McpClientSetup>("mcp_client_setup");
}

/** Whether Claude Code is installed and signed in (Rust runs `claude auth status`). */
export function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  return invoke<ClaudeCodeStatus>("claude_code_status");
}

/** Saves the claude program and Claude Code profile folder (null: forget), then checks again. */
export function setClaudeCode(program: string | null, configDir: string | null): Promise<ClaudeCodeStatus> {
  return invoke<ClaudeCodeStatus>("claude_code_set", { program, configDir });
}

/** Past chats, newest first (chat_store.rs, Phase 8a). */
export function listChats(): Promise<ChatSummary[]> {
  return invoke<ChatSummary[]>("chat_list");
}

/** A saved chat, unchecked: `parseSavedChat` checks it. */
export function loadChatFile(id: string): Promise<unknown> {
  return invoke<unknown>("chat_load", { id });
}

/** Files a chat and answers the list as it is now. */
export function saveChatFile(id: string, chat: SavedChat): Promise<ChatSummary[]> {
  return invoke<ChatSummary[]>("chat_save", { id, chat });
}

export function deleteChatFile(id: string): Promise<ChatSummary[]> {
  return invoke<ChatSummary[]>("chat_delete", { id });
}

/** Names a saved chat without opening it (Phase 8d). `auto`: the model's name, which the user's wins over;
 * a blank user name goes back to the automatic one. Answers the list. */
export function renameChatFile(id: string, title: string, auto = false): Promise<ChatSummary[]> {
  return invoke<ChatSummary[]>("chat_rename", { id, title, auto });
}

/** The saved chats whose name or messages contain `query`, newest first (Phase 8d). */
export function searchChats(query: string): Promise<ChatSearchHit[]> {
  return invoke<ChatSearchHit[]>("chat_search", { query });
}

/** The saved edit log, unchecked, or null when there is none. */
export function loadEditLogFile(): Promise<unknown> {
  return invoke<unknown>("edit_log_load");
}

export function saveEditLogFile(log: SavedEditLog): Promise<void> {
  return invoke<void>("edit_log_save", { log });
}
