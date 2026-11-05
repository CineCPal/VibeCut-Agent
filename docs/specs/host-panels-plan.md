# VibeCut Agent — In-Host Panels (Premiere Pro & DaVinci Resolve) + Menu-Bar Window Implementation Plan

**Document ID:** `vibecut.host.panels.v1`
**Status:** Ready for Execution (Claude Code CLI Handoff)
**Target Branch:** `feat/in-host-panels`
**Governance Contract:** Must preserve `EXECUTION_MODE=direct` and `EXECUTION_MODE=orchestrated` contracts (`AGENTS.md` §11, `CLAUDE.md`, `ORCHESTRATOR_SPEC.md`) and maintain the macOS top menu-bar (`ActivationPolicy::Accessory`) + standalone floating window (`main` / Mini Player) experience without regression.

---

## 1. Executive Summary & Architectural Mandate

VibeCut Agent will operate simultaneously across **three synchronized UI surfaces** backed by a single running menu-bar application (`VibeCut Agent.app`):

1. **macOS Top Menu Bar + Standalone Floating Window (Existing, Preserved):**
   - `VibeCut Agent` continues to live in the macOS top menu bar (`ActivationPolicy::Accessory` in `src-tauri/src/lib.rs`, `src-tauri/src/tray.rs` with the `"VA"` template icon).
   - Clicking **Open Agent Panel**, **Open B-Roll Library**, **Open B-Roll Analyzer**, **Open Telemetry Studio**, or **Mini Player (`⌥⌘M`)** from the top menu bar opens/focuses the standalone Tauri window (`main` or `visualizer`).
   - Closing the standalone chat window (`main`) hides it (`WindowEvent::CloseRequested`) while the menu-bar app continues running in the background.
2. **Premiere Pro Dockable In-Host Panel (`com.vibecutagent.connect`, CEP 11/12, v0.19.0):**
   - Adds **VibeCut Agent** (`com.vibecutagent.connect.chat`, **Window → Extensions → VibeCut Agent**) to `src-premiere-panel/CSXS/manifest.xml` alongside the existing hidden bridge (`com.vibecutagent.connect.panel`), **VibeCut Agent B-roll** (`com.vibecutagent.connect.broll`), and **VibeCut Agent Telemetry Studio** (`com.vibecutagent.connect.studio`).
   - Provides a dockable in-host workspace panel with **Chat · B-roll · History** tabs, native CEP file drag-and-drop (`com.adobe.cep.dnd.file.0`) into Premiere's Project panel and timeline, and a one-click **Open Window** button to pop out the standalone Tauri chat window.
3. **DaVinci Resolve Studio In-Host Plugin (`com.vibecutagent.resolve`, Workflow Integration Plugin, v0.19.0):**
   - Adds a dedicated Resolve Studio Workflow Integration plugin (`src-resolve-plugin/`, **Workspace → Workflow Integrations → VibeCut Agent**) installed into `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.vibecutagent.resolve/` from **Settings → Editors** (`src-tauri/src/resolve_plugin.rs`).
   - Uses a distinct bundle ID (`com.vibecutagent.resolve`) and bridge directory (`~/Library/Application Support/VibeCut Agent/host-bridge/chat/resolve/`) so it never collides with VibeCut's `com.vibecut.agent`.
   - Runs the exact same React host-panel UI (**Chat · B-roll · History** tabs + **Open Window** button) inside a locked-down Electron renderer (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`, no network access) with native Electron `webContents.startDrag` for dragging B-roll clips straight into Resolve's Media Pool and timeline.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                  VibeCut Agent (macOS Top Menu Bar App)                    │
│  • Single Source of Truth: useAgentStore, useEditLogStore, useLibraryStore │
│  • Owns Python Sidecar, Claude Code / Gemini Sessions, Keychain, Watchers  │
└───────┬──────────────────────────────┬─────────────────────────────┬───────┘
        │ Tauri WebviewWindow          │ CEP Node fs (files)         │ Electron IPC fs (files)
        ▼                              ▼                             ▼
┌───────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│ Standalone Window     │  │ Premiere Pro CEP Panel    │  │ DaVinci Resolve Plugin    │
│ (Menu Bar / ⌥⌘M Mini) │  │ Window → Extensions →     │  │ Workspace → Workflow      │
│ • Agent / Library /   │  │ "VibeCut Agent"           │  │ Integrations →            │
│   Analyze / Settings  │  │ • Chat · B-roll · History │  │ "VibeCut Agent"           │
│ • Can open/hide any   │  │ • CEP drag to timeline    │  │ • Chat · B-roll · History │
│   time from menu bar  │  │ • "Open Window" pop-out   │  │ • Native drag to pool/TL  │
└───────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
```

---

## 2. File-Based Transport & Security Contract

Following the proven zero-port file transport in `src-tauri/src/broll_panel.rs` (and VibeCut's `host_chat.rs`), the menu-bar app and in-host panels communicate through atomic JSON files under `~/Library/Application Support/VibeCut Agent/host-bridge/chat/<host>/` where `<host>` is `"premiere"` or `"resolve"` (overridable via `VIBECUT_AGENT_HOST_CHAT_DIR` for tests).

### 2.1 Directory Layout per Host (`premiere` and `resolve`)

```text
~/Library/Application Support/VibeCut Agent/host-bridge/chat/<host>/
├── state.json          # Atomic snapshot of Chat, Draft, Review cards, Model & Editor status (written by App)
├── broll.json          # Atomic snapshot of B-Roll Library folders, results, pool & drag paths (written by App)
├── agent-alive.json    # {"at": <epoch_ms>, "pid": <pid>} stamped every 1s by Rust
├── panel-alive.json    # {"at": <epoch_ms>} stamped every 1s by the open host panel
├── window.json         # Saved bounds {x, y, width, height} (used by Resolve's Workflow Integration window)
├── thumbs/
│   └── s<shotId>.txt   # 240px JPEG data: URLs for B-roll shot keyframes (pruned to newest 800)
└── inbox/
    └── <actionId>.json # Atomic action requests written as .<id>.json.tmp and renamed by the panel
```

> **Backward Compatibility Note:** Keep `src-tauri/src/broll_panel.rs` and `~/Library/Application Support/VibeCut Agent/host-bridge/broll/premiere/` intact so the existing standalone `VibeCut Agent B-roll` CEP panel (`com.vibecutagent.connect.broll`) continues to work unchanged.

### 2.2 Security Invariants
1. **No Credentials in Host Panels:** API keys (`GEMINI_API_KEY`, `HF_TOKEN`) and Claude Code profile paths never leave Rust/Tauri (`secrets.rs`, `sidecar.rs`) and are never written to `state.json`.
2. **Strict Inbox Validation in Rust (`src-tauri/src/host_chat.rs`):** Every file in `inbox/<id>.json` must be a regular file (`!is_symlink`, `<= 64 KiB`), with `id` matching `^[A-Za-z0-9_-]{1,64}$` and matching its filename stem. Rust parses the JSON and rebuilds a clean `Value::Object` containing **only** the allow-listed fields for that action `type` before deleting the file and emitting `host-chat-action` to the Tauri frontend.
3. **Sandboxed Resolve Renderer (`src-resolve-plugin/`):**
   - `main.js` creates `BrowserWindow` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, and blocks all non-`file:`/`devtools:` requests via `session.defaultSession.webRequest.onBeforeRequest`.
   - `files.js` (`createPanelOps`) verifies every path stays inside `~/Library/Application Support/VibeCut Agent/host-bridge/chat/resolve/` without traversing symlinks, and restricts writes strictly to `panel-alive.json`, `window.json`, and `inbox/.?<id>.json(.tmp)?`.
   - Dragging a B-roll shot from Resolve calls `ipcRenderer.send("panel:startDrag", key)`. The Electron main process looks up `key` in `broll.json`'s `paths` map, verifies it is a regular media file (`MEDIA_EXTENSIONS`, no symlink), and initiates `event.sender.startDrag({ file, icon })`.

---

## 3. Shared Data Schemas (`src/types/hostPanel.ts`)

Create `src/types/hostPanel.ts` (shared between `src/` and `src-premiere-panel-ui/`):

```ts
import type {
  AgentStatus,
  AiChoiceId,
  ClaudeFamily,
  EffortLevel,
  GeminiEffort,
  ToolFinding,
} from "./agent";
import type { PanelBrollAction, PanelBrollFile } from "./brollPanel";
import type { NleHost } from "./nle";

export const HOST_PANEL_VERSION = 1;

export interface HostPanelToolCall {
  id: string;
  name: string;
  summary: string;
  args: string;
  result?: string;
  state: "running" | "done" | "failed" | "pending" | "declined";
  findings?: ToolFinding[];
}

export interface HostPanelMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error" | "system";
  text: string;
  createdAt: number;
  status?: "pending" | "done";
  tool?: HostPanelToolCall;
  imageCount?: number;
}

export interface HostPanelQueuedItem {
  id: string;
  text: string;
  imageCount: number;
}

export interface HostPanelHistoryEntry {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface HostPanelPrompt {
  id: string;
  name: string;
  body: string;
}

export interface HostPanelStateFile {
  version: typeof HOST_PANEL_VERSION;
  publishedAt: number;
  host: NleHost;
  editor: {
    connected: boolean;
    status: string;
    product: string | null;
    version: string | null;
    project: string | null;
    timeline: string | null;
    timelines: string[];
    noEditor: string | null;
    noPlace: string | null;
  };
  agent: {
    status: AgentStatus;
    statusDetail: string | null;
    activity: string | null;
    aiChoice: AiChoiceId;
    choices: { id: AiChoiceId; label: string }[];
    effort: Record<ClaudeFamily, EffortLevel>;
    geminiEffort: GeminiEffort;
    reviewEdits: boolean;
    outsideRunning: boolean;
  };
  chat: {
    chatId: string;
    title: string;
    messages: HostPanelMessage[];
    queue: HostPanelQueuedItem[];
    queuePaused: boolean;
    canRetry: boolean;
    rewindBlocked: string | null;
    lastTurnEdits: number;
    revertable: number;
    earlierSessionRevert: boolean;
  };
  openDraft: {
    base: string;
    changes: string[];
    duration: number;
  } | null;
  history: HostPanelHistoryEntry[];
  prompts: HostPanelPrompt[];
  notice: {
    actionId: string | null;
    text: string;
    failed: boolean;
    at: number;
  } | null;
}

export type HostChatAction =
  | { id: string; type: "hello" | "stop" | "new_chat" | "retry" | "revert" | "queue_clear" | "queue_resume" | "draft_send" | "draft_discard" }
  | { id: string; type: "send"; text: string }
  | { id: string; type: "edit_last"; text: string }
  | { id: string; type: "load_chat"; chatId: string }
  | { id: string; type: "review_decision"; cardId: string; decision: "apply" | "skip" | "all" }
  | { id: string; type: "set_model"; aiChoice: AiChoiceId }
  | { id: string; type: "set_effort"; family: ClaudeFamily; effort: EffortLevel }
  | { id: string; type: "set_gemini_effort"; effort: GeminiEffort }
  | { id: string; type: "set_review_edits"; on: boolean }
  | { id: string; type: "queue_remove"; queueId: string }
  | { id: string; type: "set_playhead"; seconds: number }
  | { id: string; type: "open_window"; view?: "chat" | "library" | "broll" | "visualizer" }
  | PanelBrollAction;
```

*(In `src/types/brollPanel.ts`, export `type PanelBrollAction = PanelAction` so `HostChatAction` cleanly composes all existing B-roll actions.)*

---

## 4. Step-by-Step Implementation Phases for Claude Code

> **Instructions for Claude Code:**
> Execute Phases 1 through 6 in order. Run the verification suite at each phase boundary to guarantee zero regressions on `EXECUTION_MODE=direct`, `EXECUTION_MODE=orchestrated`, and all existing tests.

---

### Phase 1: Rust Host-Chat Bridge (`src-tauri/src/host_chat.rs`) & Window Pop-Out Integration

1. **Create `src-tauri/src/host_chat.rs`:**
   - Support both hosts (`Host::Premiere` and `Host::Resolve` from `crate::nle::Host`).
   - Resolve per-host directory:
     - If `VIBECUT_AGENT_HOST_CHAT_DIR` is set, use `<custom>/<host_str>` (where `host_str` is `"premiere"` or `"resolve"`).
     - Otherwise `~/Library/Application Support/VibeCut Agent/host-bridge/chat/<host_str>`.
   - Implement `validate_action(value: &Value, file_id: &str) -> Result<Value, String>`:
     - Validate `id == file_id` (`valid_id`: 1..=64 ASCII alphanumeric, `_`, `-`).
     - Rebuild each allowed `type` from `HostChatAction` (Section 3):
       - `"send"` / `"edit_last"`: `text` trimmed, non-empty, `<= 16_000` chars.
       - `"load_chat"`: `chatId` passes `valid_id`.
       - `"review_decision"`: `cardId` passes `valid_id`, `decision` in `["apply", "skip", "all"]`.
       - `"set_model"`: `aiChoice` in `["gemini", "gemini-pro", "claude-code-opus-5-5", "claude-code-sonnet-5-5"]`.
       - `"set_effort"`: `family` in `["opus", "sonnet"]`, `effort` in `["low", "medium", "high", "max"]`.
       - `"set_gemini_effort"`: `effort` in `["off", "low", "medium", "high"]`.
       - `"set_review_edits"`: `on` boolean.
       - `"queue_remove"`: `queueId` passes `valid_id`.
       - `"set_playhead"`: `seconds` finite `f64` in `0.0..=86_400.0`.
       - `"open_window"`: optional `view` in `["chat", "library", "broll", "visualizer"]` (defaults to `"chat"`).
       - Zero-field chat actions: `"hello"`, `"stop"`, `"new_chat"`, `"retry"`, `"revert"`, `"queue_clear"`, `"queue_resume"`, `"draft_send"`, `"draft_discard"`.
       - All B-roll actions (`"broll_open"`, `"broll_expand"`, `"broll_scope"`, `"broll_clear_scope"`, `"broll_search"`, `"broll_more"`, `"broll_pool"`, `"broll_import"`, `"broll_place"`, `"broll_source"`) delegated to `crate::broll_panel::validate_action(value, file_id)`.
   - Spawn a background thread in `pub fn start(app: &AppHandle)` that loops every `150ms`:
     - For each host (`Premiere`, `Resolve`), if its directory exists:
       - Stamps `agent-alive.json` every `1s` via `write_atomic`.
       - Drains `inbox/*.json` oldest-first, deletes each file, and:
         - If the validated action is `"open_window"`, handles it directly in Rust by calling `crate::tray::open_view(&app, view)` (or `crate::visualizer::open(&app)` when `view == "visualizer"`) **and** still emits `host-chat-action` so the UI knows.
         - Emits `host-chat-action` with payload `{ host, action, error, fileId }`.
   - Expose Tauri commands:
     - `host_chat_publish(host: Host, state: Value) -> Result<bool, String>` (writes `state.json` atomically if the host's folder exists; max `4 MiB`).
     - `host_chat_broll_publish(host: Host, file: Value) -> Result<bool, String>` (writes `broll.json` atomically in the host's folder; max `4 MiB`).
     - `host_chat_thumbs(app: AppHandle, host: Host, shot_ids: Vec<i64>) -> Result<Vec<i64>, String>` (reuses `broll_panel`'s thumbnail generator into `<host_dir>/thumbs/`).
     - `host_chat_status(host: Host) -> Result<bool, String>` (true when `<host_dir>/panel-alive.json` was modified within `5s`).
2. **Wire `host_chat` in `src-tauri/src/lib.rs`:**
   - Add `mod host_chat;`.
   - Call `host_chat::start(app.handle());` in `.setup(...)`.
   - Register `host_chat::host_chat_publish`, `host_chat::host_chat_broll_publish`, `host_chat::host_chat_thumbs`, and `host_chat::host_chat_status` in `tauri::generate_handler![...]`.
3. **Add unit tests in `src-tauri/src/host_chat.rs`:**
   - Test `validate_action` for every chat and B-roll action variant, field stripping, oversized/invalid inputs, and `drain_inbox` ordering.

---

### Phase 2: App-Side Host-Chat Bridge (`src/lib/hostChatBridge.ts`)

1. **Create `src/lib/hostChatBridge.ts`:**
   - Build `buildHostStateFile(host: NleHost, now = Date.now()): HostPanelStateFile`:
     - Reads `useAgentStore`, `useNleStateStore`, `useEditLogStore`, `useConnectionStore`, `useChatHistoryStore`, `useMcpStore`, and `usePromptStore`.
     - Maps `messages` to `HostPanelMessage[]` (including `tool` state, `findings`, `imageCount`, and streaming `pending` status).
     - Computes `canRetry = Boolean(lastTurn) && status === "idle" && !rewindBlockReason()`, `rewindBlocked = rewindBlockReason()`, `lastTurnEdits = lastTurnEdits().length`, `revertable = lastEditStep(entries).length`.
   - Build `buildHostBrollFile(host: NleHost, now = Date.now()): PanelBrollFile`:
     - Parameterize `buildBrollFile` in `src/lib/brollPanel.ts` so it accepts `host: NleHost = "premiere"` and builds the editor status block for either `"premiere"` or `"resolve"`.
   - Implement `handleHostChatAction(host: NleHost, action: HostChatAction): Promise<void>`:
     - Before running a host-scoped action (`send`, `edit_last`, `retry`, `revert`, `draft_send`, `draft_discard`, `set_playhead`, `broll_import`, `broll_source`, `broll_place`), if `useNleStateStore.getState().hosts[host].status === "connected"` and `selectActiveHost(useNleStateStore.getState()) !== host`, set `useNleStateStore.getState().setPreferredHost(host)` so the turn and tools operate on the editor whose panel sent the command.
     - Route each action to the canonical app controller:
       - `"hello"`: `openLibrary()` + immediate publish.
       - `"send"`: `submitMessage(action.text)`.
       - `"stop"`: `stopTurn()`.
       - `"new_chat"`: `newConversation()`.
       - `"load_chat"`: load the saved chat via `loadChat(action.chatId)` from `src/lib/ipc.ts` and pass to `newConversation(saved)`.
       - `"retry"`: `retryLastTurn()`.
       - `"edit_last"`: `sendEditedMessage(action.text)`.
       - `"revert"`: `revertLastRequest({ byUser: true })` and append its summary to `useAgentStore`.
       - `"review_decision"`: `answerReview(action.cardId, action.decision)`.
       - `"set_model"`: `useAgentStore.getState().setAiChoice(action.aiChoice)`.
       - `"set_effort"`: `useAgentStore.getState().setEffort(action.family, action.effort)`.
       - `"set_gemini_effort"`: `useAgentStore.getState().setGeminiEffort(action.effort)`.
       - `"set_review_edits"`: `useAgentStore.getState().setReviewEdits(action.on)`.
       - `"queue_remove"`: `useAgentStore.getState().removeQueued(action.queueId)`.
       - `"queue_clear"`: `useAgentStore.getState().clearQueue()`.
       - `"queue_resume"`: `resumeQueue()`.
       - `"draft_send"` / `"draft_discard"`: `sendDraft(...)` / `discardDraft(host)`.
       - `"set_playhead"`: `nleCall(host, "set_playhead", { timeline, time: action.seconds })`.
       - B-roll actions: delegate to `handleBrollAction(action, host)` in `src/lib/brollPanel.ts` (updated to accept `host: NleHost = "premiere"`).
   - Implement `startHostChatBridge(): () => void`:
     - Subscribes to `useAgentStore`, `useNleStateStore`, `useEditLogStore`, `useConnectionStore`, `useChatHistoryStore`, `useLibraryStore`, `useMcpStore`, and `usePromptStore`.
     - Coalesces writes (`80ms`) and invokes `host_chat_publish` + `host_chat_broll_publish` (plus `host_chat_thumbs` when B-roll shots need thumbnails) for `"premiere"` and `"resolve"`.
     - Listens to `host-chat-action` and dispatches to `handleHostChatAction`.
2. **Mount `startHostChatBridge()` in `src/App.tsx`:**
   - Add `useEffect(() => startHostChatBridge(), []);` alongside `startBrollPanelBridge()`.
3. **Add unit tests in `src/lib/hostChatBridge.test.ts`:**
   - Verify state serialization, host switching when an action arrives from Premiere vs. Resolve, review card decisions (`apply` / `skip` / `all`), chat send/stop/retry/revert, and B-roll delegation.

---

### Phase 3: Shared Host-Panel UI (`src-premiere-panel-ui/` — Chat, B-Roll & History Tabs)

`src-premiere-panel-ui/panel.css` already contains all of VibeCut's CSS classes for the in-host Chat, Tool steps, Draft bar, Model selector chips, Tabs, History, and B-roll (`.vc-tabs`, `.vc-tab`, `.vc-messages`, `.vc-msg-*`, `.vc-steps*`, `.vc-draft`, `.vc-composer`, `.vc-history*`).

1. **Extend `src-premiere-panel-ui/transport.ts`:**
   - Add `readState(): Promise<HostPanelStateFile | null>` to `Transport` (reading `state.json` and checking `file.version === HOST_PANEL_VERSION`).
   - Widen `send(action: HostChatAction): Promise<void>`.
   - Add `panelChatDir(home: string, host: "premiere" | "resolve")` returning `${home}/Library/Application Support/VibeCut Agent/host-bridge/chat/${host}`.
2. **Create `src-premiere-panel-ui/useHostPanel.ts`:**
   - Polls `transport.readState()`, `transport.readBroll()`, and `transport.agentAliveAt()` every `250ms` and stamps `transport.heartbeat()` every `1000ms`.
   - Sends `{ id: newActionId(), type: "hello" }` on mount.
   - Exposes `{ state, broll, agentRunning, pending, writeError, act }`.
3. **Create `src-premiere-panel-ui/ChatTab.tsx`:**
   - **Top Row / Context:**
     - Shows active timeline (`state.editor.timeline ?? "No open timeline"`), `Revert N` button when `state.chat.revertable > 0`, and `New chat` button when `state.chat.messages.length > 0`.
   - **Open Draft Bar (`.vc-draft`):**
     - When `state.openDraft` is present, shows `Draft of "${base}": ${changes.length} change(s)` with **Send** (`draft_send`) and **Discard** (`draft_discard`).
   - **Message List (`.vc-messages`):**
     - Renders user, assistant, error, and grouped tool messages (`.vc-steps` collapsible group when consecutive tool calls occur).
     - Clicking a timecode pattern (`\b\d{1,2}:\d{2}(?::\d{2}(?:[:;]\d{2})?)?\b`) in assistant replies or tool findings dispatches `{ type: "set_playhead", seconds }`.
     - When a tool message has `tool.state === "pending"` (Review edits first), renders inline **Apply**, **Skip**, and **Apply all** buttons dispatching `{ type: "review_decision", cardId, decision }`.
     - Shows `Retry` / `Revert N & retry` and `Edit` on the last user turn when `state.chat.canRetry` is true.
     - Shows the live working indicator (`.vc-working`) when `state.agent.activity` is non-null.
   - **Queue Bar:**
     - When `state.chat.queue.length > 0`, lists queued messages with remove (`queue_remove`), **Send next** (`queue_resume` when paused), and **Clear** (`queue_clear`).
   - **Composer (`.vc-composer`):**
     - Model selector `<select className="vc-select">` (`state.agent.choices`), Effort `<select className="vc-select">`, and a **Review edits** checkbox (`Check` component using `.vc-check` / `.vc-box`).
     - Multi-line `<textarea className="vc-input">` supporting `Enter` to send/queue, `Shift+Enter` for newline, `↑` in an empty box to edit the last message (`edit_last`), and `/` saved-prompt picker from `state.prompts`.
     - **Send** / **Queue** button (`.vc-btn .vc-btn-primary`) and **Stop** button (`.vc-btn .vc-btn-stop`) while `thinking`.
4. **Create `src-premiere-panel-ui/HistoryTab.tsx`:**
   - Filterable list of `state.history` entries (`title`, message count, relative date) that dispatches `{ type: "load_chat", chatId }` and switches to the Chat tab, plus a **New chat** button.
5. **Create `src-premiere-panel-ui/HostApp.tsx`:**
   - Header (`.vc-header .vc-slim`) with:
     - Status dot (`.vc-dot-on` when `agentRunning && state?.editor.connected`, `.vc-dot-wait` when `agentRunning`, `.vc-dot-off` when offline).
     - Status text (`"VibeCut Agent isn't running — launch it from the top menu bar"` when offline, else project · timeline).
     - **Window** button (`.vc-btn`, title `"Open VibeCut Agent's floating window"`, dispatching `{ type: "open_window", view: activeTab === "broll" ? "library" : "chat" }`).
   - Tab bar (`.vc-tabs`) with **Chat**, **B-roll**, and **History** tabs (`.vc-tab` / `.vc-tab-on`).
6. **Add unit tests in `src-premiere-panel-ui/HostApp.test.tsx`:**
   - Test tab switching (Chat, B-roll, History), sending a chat message, clicking Apply/Skip on a pending review card, clicking Revert, clicking the "Window" pop-out button (`open_window`), and B-roll tab rendering.

---

### Phase 4: Premiere Pro Dockable Agent Panel (`src-premiere-panel/`, v0.19.0)

1. **Create `src-premiere-panel/chat/index.html`:**
   ```html
   <!doctype html>
   <html lang="en">
     <head>
       <meta charset="utf-8" />
       <title>VibeCut Agent</title>
       <link rel="stylesheet" href="./dist/panel.css" />
     </head>
     <body>
       <div id="root"></div>
       <script src="./dist/panel.js"></script>
     </body>
   </html>
   ```
2. **Create `src-premiere-panel-ui/cepChat.tsx`:**
   - Same CEP Node `fs` `FileOps` setup as `src-premiere-panel-ui/cep.tsx`, pointed at `panelChatDir(os.homedir(), "premiere")` with `{ fillDrag }`, rendering `<HostApp transport={transport} hostName="Premiere Pro" />`.
3. **Update `vite.panel.config.ts` (or add `vite.chat-panel.config.ts` & wire into `npm run build:panel`):**
   - Build both:
     - `src-premiere-panel/broll/dist/panel.{js,css}` (existing standalone B-roll panel, from `cep.tsx`)
     - `src-premiere-panel/chat/dist/panel.{js,css}` (new full VibeCut Agent panel, from `cepChat.tsx`)
     - `src-resolve-plugin/dist/panel.{js,css}` (Resolve Workflow Integration bundle, from `electron.tsx` in Phase 5)
4. **Update `src-premiere-panel/CSXS/manifest.xml` and `src-premiere-panel/bridge.js`:**
   - Bump `ExtensionBundleVersion` (and `PANEL_VERSION` in `bridge.js`) to `"0.19.0"`.
   - Add `<Extension Id="com.vibecutagent.connect.chat" Version="0.19.0" />` to `<ExtensionList>`.
   - Add its `<DispatchInfo>` block under `<DispatchInfoList>`:
     - `<MainPath>./chat/index.html</MainPath>`
     - `<CEFCommandLine>` with `--enable-nodejs` and `--mixed-context`
     - `<UI>`: `<Type>Panel</Type>`, `<Menu>VibeCut Agent</Menu>`, `<Size>` `Width: 380`, `Height: 680`, `<MinSize>` `Width: 280`, `Height: 360`.
   - Remember: **no double hyphens** inside XML comments in `manifest.xml`.
5. **Update `src-tauri/src/premiere_panel.rs` and `src-tauri/tauri.conf.json`:**
   - Add `"chat/index.html"`, `"chat/dist/panel.js"`, and `"chat/dist/panel.css"` to `PANEL_FILES` in `src-tauri/src/premiere_panel.rs` and `bundle.resources` in `src-tauri/tauri.conf.json`.
   - Update `the_repositorys_panel_is_complete_versioned_and_not_vibecuts` in `src-tauri/src/premiere_panel.rs` to assert version `"0.19.0"`.

---

### Phase 5: DaVinci Resolve Studio Workflow Integration Plugin (`src-resolve-plugin/` & `src-tauri/src/resolve_plugin.rs`)

1. **Create `src-resolve-plugin/`:**
   - `manifest.xml`:
     ```xml
     <?xml version="1.0" encoding="UTF-8"?>
     <!-- VibeCut Agent's Workflow Integration panel for DaVinci Resolve Studio. Installed from Settings > Editors. -->
     <BlackmagicDesign>
         <Plugin>
             <Id>com.vibecutagent.resolve</Id>
             <Name>VibeCut Agent</Name>
             <Version>0.19.0</Version>
             <Description>VibeCut Agent chat and B-roll panel for DaVinci Resolve. VibeCut Agent must be running in the menu bar.</Description>
             <FilePath>main.js</FilePath>
         </Plugin>
     </BlackmagicDesign>
     ```
   - `package.json`: `{"name": "vibecut-agent-resolve-plugin", "version": "0.19.0", "private": true, "main": "main.js"}`.
   - `files.js`: Ported from VibeCut's `files.js` (`createFileOps`, `createPanelOps`, `dragTarget`), with `chatDir(home)` pointing to `path.join(home || os.homedir(), "Library", "Application Support", "VibeCut Agent", "host-bridge", "chat", "resolve")` (never VibeCut's folder).
   - `preload.js`: Exposes `window.vibecutPanel = { chatDir, readText, writeText, rename, makeDir, startDrag }` via `contextBridge.exposeInMainWorld`.
   - `main.js`: Electron main process opening `index.html` (`width: 420, height: 720, minWidth: 300, minHeight: 360`, `backgroundThrottling: false`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, network blocked via `webRequest.onBeforeRequest`, native file drag via `event.sender.startDrag`).
   - `index.html`: Loads `./dist/panel.css` and `./dist/panel.js` with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;" />`.
2. **Create `src-premiere-panel-ui/electron.tsx`:**
   - Bridges `window.vibecutPanel` (`readText`, `writeText`, `rename`, `makeDir`, and `fillDrag` calling `vibecutPanel.startDrag(key)`) into `fileTransport(vibecutPanel.chatDir, ops, { fillDrag })` and renders `<HostApp transport={transport} hostName="DaVinci Resolve" />`.
   - Bundled into `src-resolve-plugin/dist/panel.{js,css}` as part of `npm run build:panel` (and `npm run build`).
3. **Create `src-tauri/src/resolve_plugin.rs`:**
   - Mirror `src-tauri/src/premiere_panel.rs` for DaVinci Resolve:
     - `BUNDLE_ID = "com.vibecutagent.resolve"` (never touches `com.vibecut.agent`).
     - `PLUGIN_FILES`: `["manifest.xml", "package.json", "main.js", "preload.js", "files.js", "index.html", "dist/panel.js", "dist/panel.css"]`.
     - Target directory: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins` (overridable in tests).
     - Status struct `ResolvePluginStatus`: `{ resolveInstalled, bundledVersion, installedVersion, installedPath, running }` where `running` checks `panel-alive.json` in `~/Library/Application Support/VibeCut Agent/host-bridge/chat/resolve/`.
     - Tauri commands: `resolve_plugin_status`, `resolve_plugin_install`, `resolve_plugin_uninstall`.
   - Bundle `../src-resolve-plugin/*` in `src-tauri/tauri.conf.json` under `resolve-plugin/` and update `tests/test_bundle_resources.py` if needed.
4. **Wire into Frontend Settings & About (`src/lib/ipc.ts`, `src/types/nle.ts`, `src/components/settings/EditorsSection.tsx`, `src/components/about/AboutModal.tsx`):**
   - Add `ResolvePluginStatus` and IPC wrappers `getResolvePluginStatus()`, `installResolvePlugin()`, `uninstallResolvePlugin()`.
   - In `EditorsSection.tsx`, add a **DaVinci Resolve plugin** install/update/uninstall card right below **Premiere panel**, advising: *"After installing or updating, restart DaVinci Resolve and open Workspace → Workflow Integrations → VibeCut Agent."*
   - Add unit tests in `src-resolve-plugin/files.test.ts` (testing path traversal rejection, symlink rejection, write allow-list, and `dragTarget`), `src-tauri/src/resolve_plugin.rs`, and `src/components/settings/EditorsSection.test.tsx`.

---

### Phase 6: Documentation & Full Verification Gate

1. **Update `PLAN.md`, `README.md`, and `QUICKSTART.md`:**
   - Document the new **VibeCut Agent** dockable panel in Premiere Pro (`Window → Extensions → VibeCut Agent`) and DaVinci Resolve (`Workspace → Workflow Integrations → VibeCut Agent`), how both coexist with the macOS top menu bar and standalone floating window, and how to install/update both from **Settings → Editors**.
2. **Run the Full Verification Gate:**

```bash
# 1. Build host panels (Premiere B-roll, Premiere Agent, Studio, Resolve plugin) + main frontend
npm run build

# 2. Frontend ESLint, TypeScript & Vitest (including new hostChatBridge, HostApp, files.js, EditorsSection tests)
npm run lint
npx tsc --noEmit
npm run test:run
npm --prefix apps/visualizer run test:run

# 3. Rust Tauri crate tests (host_chat, premiere_panel, resolve_plugin, tray, visualizer)
cargo test --manifest-path src-tauri/Cargo.toml

# 4. Python lint, mypy & pytest (verifying zero regression on direct & orchestrated modes)
uvx ruff check src-python/ tests/
uv run mypy src-python/ tests/
uv run pytest tests/ -v
```

