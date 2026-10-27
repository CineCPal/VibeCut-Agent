# VibeCut Agent – Implementation Plan

## System Overview & Mandate
VibeCut Agent is a standalone desktop application (Tauri v2) providing the AI Chat Agent and B-Roll Analyzer panels from VibeCut, but separated from VibeCut's full NLE and color grading interfaces. 

It is designed to run locally in the background, launching independently and interacting with DaVinci Resolve and Premiere Pro via their respective plugin/CEP APIs or direct API bridges, functioning as a "sidecar" editing assistant.

## Tech Stack (per `AGENTS.md`)
- **Frontend:** React 19 + Vite 7 + Tailwind CSS v4 + Zustand v5.
- **Backend:** Rust (Tauri commands, IPC, File System, OS events) + Python sidecar (ML pipelines, LLM APIs, and NLE bridge scripts).
- **Styling:** Adheres strictly to the VibeCut dark-mode design tokens (Athletic Blue, Canvas, Surface, etc.).
- **Security:** Local-first, `.env` for LLM API keys (Gemini / Claude).

## Architecture Blueprint

### 1. Tauri Backend (Rust)
**Location:** `src-tauri/src/`
- **IPC Commands:** Handlers for UI to execute Python scripts or request filesystem access without blocking the UI thread.
- **Top Bar / System Tray Execution:** The app must launch hidden in the background by default and live in the macOS top bar (menu bar) via Tauri's Tray API. 
- **Tray Menu:** The top bar icon's context menu must provide quick access to "Open Agent Panel", "Open B-Roll Analyzer", "Settings", "About This App", and "Quit".
- **Memory Safety:** Heavy processing (e.g. video probing, file loading) occurs via streaming or asynchronous chunked processing to ensure the UI remains responsive.

### 2. Python Sidecar (ML & NLE Bridge)
**Location:** `src-python/`
- **NLE Bridging:** Re-use or adapt the existing VibeCut `src-premiere-panel` / `src-resolve-plugin` communication logic to send commands like `nest_clips`, `duck_music`, `analyze_pool_broll`, etc. *(Corrected 2026-10-05: VibeCut does not use websockets. Its bridge is file-based, under `~/Library/Application Support/VibeCut/host-bridge/` (`jobs/<id>.json`, `replies/<id>.json`, `alive.json`; see VibeCut `src-python/host-premiere/bridge.py`, `src-premiere-panel/bridge.js`, `src-resolve-plugin/main.js`). Phase 3 adapted that file protocol with its own panel and folder, so VibeCut Agent never shares VibeCut's queue; see "NLE Bridge (Phase 3)".)*
- **Sidecar transport:** stdio JSON lines, as in VibeCut `src-tauri/src/sidecar.rs` + `src-python/utils/.../sidecar_protocol.py`: Rust spawns `uv run --locked python -u headless.py <cmd>`, writes the request as one JSON line on stdin (injecting API keys from the environment; the frontend never holds them), and relays `{type, ...}` stdout lines to the UI as events.
- **LLM Orchestration:** `gemini_chat.py` / `claude_chat.py` handles the multi-step editing agent logic, exposing a structured output format back to the Rust backend and then to the React UI.

### 3. Frontend UI (React + Tailwind)
**Location:** `src/`
- **`src/components/chat/`**: The conversational AI interface.
- **`src/components/broll/`**: The B-Roll analyzer interface.
- **`src/store/`**: Zustand stores for chat history, b-roll selects, and NLE connection state.
- **`src/lib/`**: IPC wrappers and event listeners.
- **"About This App" Modal:** Required per `AGENTS.md`, showing the connection status to the NLEs, the active LLM, and local dependencies (ffmpeg).

## Step-by-Step Implementation Plan for Claude

### Phase 1: Core UI & State Scaffolding ✅ (done 2026-10-05)
- Implement the Zustand stores (`useAgentStore.ts`, `useNleStateStore.ts`).
- Build the base UI layout: A compact floating window format with tabs or a split view for Chat and B-Roll.
- **Top Bar Tray & Routing:** Configure Tauri to launch hidden. Implement the Tray menu in Rust to open specific UI routes (Chat vs. B-Roll vs. Settings).
- Implement the `AGENTS.md` compliant "About This App" modal and "Settings" panel (showing connection status, active LLM, API keys, and local dependencies).

### Phase 2: Rust IPC & Python Sidecar Setup ✅ (done 2026-10-05)
- Configure Tauri to bundle and spawn the Python sidecar.
- Define Rust `commands.rs` to proxy messages between the React frontend and the Python sidecar via standard I/O or local WebSockets.
- Ensure all Python execution is asynchronous and never blocks the UI thread.

### Phase 3: NLE Bridge Implementation ✅ (connection layer, done 2026-10-05)
- Adapt the Premiere/Resolve bridge scripts from the original VibeCut repo to run from the Python sidecar of this standalone agent.
- Implement robust state recovery: if Premiere/Resolve restarts, the Agent should detect this and re-sync.

### Phase 4: Chat Agent & B-Roll Logic ✅ (4a: read + marker tools, B-roll analyze/match; 4b: direct edits with backup + Revert; done 2026-10-05)
- Wire up the UI chat interface to the LLM agent via the Rust/Python bridge.
- Implement the B-Roll Analyzer, piping media metadata and tags to the UI and allowing the user to push edits back to the NLE.
- Add deterministic progress indicators (ETA, percentage) for long-running tasks like B-Roll analysis.

## IPC Surface (as of Phase 4)

| Kind | Name | Rust | Frontend wrapper (`src/lib/ipc.ts`) | Returns / payload |
|---|---|---|---|---|
| command | `take_pending_view` | `commands.rs` | `takePendingView()` | `View \| null`, the view the tray requested before the webview was listening |
| command | `llm_key_status` | `commands.rs` | `getKeyStatus()` | `{ gemini, anthropic }` booleans (whether the key is present; values never leave Rust) |
| command | `dependency_status` | `commands.rs` | `getDependencyStatus()` | `[{ name, path, version }]` for ffmpeg, ffprobe, exiftool, uv (PATH, then `/opt/homebrew/bin`, `/usr/local/bin`) |
| command | `hardware_acceleration` | `commands.rs` | `getHardwareAcceleration()` | `{ videotoolbox, nvenc }` from `ffmpeg -encoders` |
| command | `storage_paths` | `commands.rs` | `getStoragePaths()` | `{ config, data, logs }` app directories |
| command | `sidecar_start` | `sidecar.rs` | `startSidecar(jobId, command, request)` | starts a job from the `COMMANDS` allow-list: `health`, `chat` (interactive; Rust injects the provider's key, or for `claude-code` the Claude Code setup as `claudeCode`, Phase 7b), `broll-analyze`, `broll-match`, `broll-export` (Phase 10: an XML for Premiere or Resolve from chosen segments, read from the folder cache; Phase 16a: each source's start timecode is probed), `broll-spyglass` (Rust sets its `indexPath`; `--extra energy` per `extras_for`), `transcribe` (`--extra transcribe`, plus `diarize` and the HF token only when it labels speakers), `audio-peaks`, and (6d) `assemble` (Rust injects the chat provider's key, as for `chat`: `needs_llm_key`). Rust-owned commands (`session`, the watchers) are refused |
| command | `sidecar_send` | `sidecar.rs` | `sendToSidecar(jobId, message)` | writes one JSON line to an interactive job (`agent-session`); any `apiKey` or `claudeCode` is stripped |
| command | `sidecar_cancel` | `sidecar.rs` | `cancelSidecar(jobId)` | SIGTERM to the process group, SIGKILL after 3 s |
| command | `sidecar_session_status` | `sidecar.rs` | `getSessionStatus()` | `{ state: "starting" \| "ready" \| "stopped", version, python, message }` |
| command | `sidecar_session_restart` | `sidecar.rs` | `restartSession()` | stops the session and starts a fresh one |
| command | `sidecar_info` | `sidecar.rs` | `getSidecarInfo()` | `{ uvPath, pythonRoot, installed, environment }` |
| command | `nle_state` | `nle.rs` | `getNleState()` | `NleState[]` for premiere and resolve |
| command | `nle_call` | `nle.rs` | `nleCall(host, command, args)` | one call through the host's watcher, waiting up to 35 s. Reads (`READ_CALLS` in watch.py): `status`, `read_timeline`, markers, playhead. Direct edits (`edits.py`): `backup_timeline`, `add_clips`, `delete_clips`, `nest_clips`, `set_clips_enabled`, `set_clip_levels`, `reshape_clip`, `set_clip_fades`, `split_clips`, `set_links` (6c), `revert_timeline_changes`, plus `duck_clip` (Premiere) or `set_transition` (Resolve). Library (`media.py`, not logged or revertible): `import_media`, `source_preview`. Project (`project.py`, Phase 6a): `create_timeline`, `duplicate_timeline`, `open_timeline`, `rename_timeline`, `select_pool_clips`, `read_media_pool`, `get_clip_info`, `search_media_pool`, plus `select_items` (Premiere); and (6b) `rebuild`, which waits up to 200 s (`call_timeout`) |
| command | `nle_reconnect` | `nle.rs` | `nleReconnect(host)` | restarts that host's watcher now, clearing any backoff or give-up |
| command | `premiere_panel_status` / `_install` / `_uninstall` | `premiere_panel.rs` | `getPremierePanelStatus()` etc. | `{ premiereInstalled, bundledVersion, installedVersion, installedPath, debugMode, running }` |
| command | `read_transcript` / `read_suite_sync` | `transcript.rs` | `readTranscript(mediaPath)` (`src/lib/agent/transcriptTools.ts`) | a file's `<media>.ivt-cache.json` transcript (VibeCut's reader verbatim: refused when the file changed since), and A-Sync's offsets beside a video (used in 6c) |
| command | `sync_audio` / `cancel_audio_sync` | `audiosync.rs` | `syncAudio(cameras, recorders)` (`src/lib/agent/syncTools.ts`) | 6c: `{ matches: [{ camera, recorder, offset, score, confidence, matched, refined, driftSeconds, overlapSeconds }], errors }` by waveform (camera time = recorder time + offset), with `audio-sync-progress` events; cancel ends it with "Cancelled" |
| command | `media_durations` | `commands.rs` | `mediaDurations(paths)` (`syncTools.ts`) | each file's length in seconds by ffprobe, or null |
| command | `keep_on_top_status` / `set_keep_on_top` | `window_mode.rs` | `getKeepOnTop()`, `setKeepOnTop(on)` | Keep on Top of Editors (saved in `window.json`, on by default): always-on-top plus, on macOS, `CanJoinAllSpaces` + `FullScreenAuxiliary`, so the window shows over a full-screen Premiere or Resolve |
| event | `keep-on-top` | `window_mode.rs` | `onKeepOnTop(cb)` | the new setting, whichever control changed it (header pin, Settings → Window, tray "Keep on Top of Editors") |
| command | `find_spyglass_index` | `spyglass.rs` | `findSpyglassIndex()` (`src/lib/spyglassIpc.ts`) | `{ path, source: environment \| chosen \| default, chosen } \| null` |
| command | `spyglass_choose_index` | `spyglass.rs` | `chooseSpyglassIndex(path \| null)` | saves (after checking it's a Spyglass index) or forgets the index chosen in Settings; returns the new `find_spyglass_index` |
| command | `spyglass_folder_children` / `spyglass_resolve_scope` / `spyglass_browse` / `spyglass_keyframes` | `spyglass.rs` | `spyglassFolderChildren`, `resolveSpyglassScope`, `browseSpyglass`, `spyglassKeyframes` | the folder tree, a scope's clip ids + summary, a page of shots, and keyframe paths (each allowed on the asset protocol one by one). Read only |
| command | `spyglass_start_drag` | `spyglass.rs` | `startShotDrag(shotId)` | a native macOS file drag of the shot's whole clip (the `drag` crate); Rust looks the file up in the index, so the webview never names a path |
| command | `broll_panel_publish` / `broll_panel_thumbs` / `broll_panel_status` | `broll_panel.rs` | `invoke` in `src/lib/brollPanel.ts` | write `broll.json` (false when the Premiere B-roll panel has never run); write shots' thumbnails, returning those that exist; whether the panel is open |
| event | `broll-panel-action` | `broll_panel.rs` | `listen` in `src/lib/brollPanel.ts` | `{ action, error, fileId }`: one checked action from the Premiere B-roll panel's inbox |
| command | `mcp_reply` | `mcp_bridge.rs` | `mcpReply(id, reply)` | 7a: writes `replies/<id>.json` for the MCP shim (`{ ok, result, summary? }` or `{ ok: false, error }`); an oversized reply becomes an error |
| command | `mcp_status` / `mcp_set_outside_allowed` | `mcp_bridge.rs` | `getMcpStatus()`, `setMcpOutsideAllowed(on)` | 7a: `{ outsideAllowed, lastOutsideAt, folder }`; Allow is saved in `mcp.json`, off by default |
| command | `mcp_client_setup` | `mcp_bridge.rs` | `getMcpClientSetup()` | 7d: `{ launch: { program, args, env }, claudeAdd }`, the shim's launch with this build's paths and the `claude mcp add --scope user …` line |
| event | `mcp-request` | `mcp_bridge.rs` | `onMcpRequest(cb)` | 7a: `{ id, caller, kind: list_tools \| call_tool, name?, args? }`, checked and rebuilt by Rust; refused requests (outside while Allow is off, a chat job that isn't running) never arrive |
| event | `mcp-outside` | `mcp_bridge.rs` | `onMcpOutside(cb)` | 7a: the `mcp_status` shape, after Allow changes |
| command | `claude_code_status` / `claude_code_set` | `claude_code.rs` | `getClaudeCodeStatus()`, `setClaudeCode(program, configDir)` | 7b: `{ program, programSaved, configDir, signedIn, email, subscription, detail }` from `claude auth status --json`; the program and profile folder are saved in `claude-code.json` |
| command | `antigravity_status` / `antigravity_set` / `antigravity_add_tools` / `antigravity_remove_tools` | `antigravity.rs` | `getAntigravityStatus()`, `setAntigravity(program)`, `addAntigravityTools()`, `removeAntigravityTools()` | 17: `{ program, programSaved, signedIn, models, toolsAdded, toolsCurrent, detail }`. Sign-in and the Gemini families come from `agy models` (no model call). The tools' state is read from `~/.gemini/config/mcp_config.json`. Add and Remove run `agy mcp add vibecut -- /usr/bin/env K=V … <shim>` and `agy mcp remove vibecut`, only on the user's click. The program is saved in `antigravity.json` |
| event | `navigate` | `tray.rs` → main window | `onNavigate(cb)` | `"chat" \| "library" \| "broll" \| "settings" \| "about"` (`"broll"` is the Analyze tab) |
| event | `sidecar-event` | `sidecar.rs` | `onSidecarEvent(cb)` | `{ jobId, command, event }`; `event` is one protocol object `{ type, ... }`. Chat: `status`, `retry`, `tool_calls`, `result`, `error`. B-roll: `starting`, `status`, `progress {fraction, phase, detail}`, `result`, `error`, `done` |
| plugin | dialog `open` | `tauri-plugin-dialog` | `chooseFolder(title)` | the B-roll folder picker (`dialog:allow-open`) |
| plugin | dialog `save` | `tauri-plugin-dialog` | `chooseSavePath(title, defaultPath, extensions)` | Phase 10: where the Analyze tab's Premiere XML goes (`dialog:allow-save`) |
| command | `broll_preview_allow` | `broll_preview.rs` | `allowPreview(path)` | Phase 10: lets the asset protocol read one clip for the Analyze tab's player, after checking it's an absolute path to an existing file with a video extension. The config's asset scope stays empty |
| plugin | opener `revealItemInDir` | `tauri-plugin-opener` | `revealInFinder(path)` | Show in Finder for a B-roll result |
| event | `sidecar-exit` | `sidecar.rs` | `onSidecarExit(cb)` | `{ jobId, code, cancelled, message }` |
| event | `nle-state` | `nle.rs` | `onNleState(cb)` | `NleState`: `{ host, status: connecting \| connected \| disconnected \| error \| unavailable, message, product, version, project, timeline, timelines, reason, changedAt }` |
| event | `sidecar-session` | `sidecar.rs` | `onSessionStatus(cb)` | the session status, on every change |

`View` lives in `src-tauri/src/state.rs` and `src/types/system.ts`, and sidecar shapes live in `sidecar.rs` and `src/types/sidecar.ts`. Keep each pair in sync. The command allow-list exists twice, in `COMMANDS` in `sidecar.rs` and `COMMANDS` in `src-python/vibecut_agent/headless.py`; add a command to both.

## Sidecar Runtime (Phase 2)

**How a run starts.** The command is `uv run --locked --no-dev --project <root> python -u -m vibecut_agent <command>`, with:
- `PYTHONPATH=<root>/src-python`.
- A cleared environment. Only `HOME`, locale, proxy settings and the `VIBECUT_*`, `UV_*`, `HF_*` and `XDG_*` variables pass through. **API keys never pass through the environment.**

**Where `<root>` is:**

| Build | Root | Virtual environment |
|---|---|---|
| Dev | The repository | The repo's `.venv` |
| Release | `VibeCut Agent.app/Contents/Resources/python/`, bundled from `pyproject.toml`, `uv.lock`, `.python-version` and `src-python/vibecut_agent/*.py` (`bundle.resources` in tauri.conf.json) | `<app data>/python-env`, set with `UV_PROJECT_ENVIRONMENT` so nothing is written into the signed bundle |

**Overrides:** `VIBECUT_AGENT_PYTHON_ROOT` and `VIBECUT_UV`.

**Requirement:** release builds need `uv` installed on the user's machine. uv fetches the pinned Python on first run.

**The agent session:**
- Rust starts it in `setup` with the job id `agent-session` and owns it.
- Its first stdin line is the start request; it answers `ready` (with `version` and `python`).
- After that, one JSON message per line:
  - `ping` → `pong`.
  - `end_session` → `done`, then it exits.
  - Anything unknown → `error`, and the session keeps running.
- It exits when stdin closes. Killing the app with SIGTERM or SIGKILL therefore leaves no Python behind; this was checked live. A normal quit also kills every job (`RunEvent::Exit`).
- A generation counter keeps a session that is still shutting down after a restart from overwriting the new session's status.

**Frontend:**
- `useSidecarBridge` (mounted in `App`) feeds `sidecar-session` into `useSidecarStore.session`. It feeds job events and exits into `useSidecarStore.jobs`, whose progress/ETA reducer is ported from VibeCut.
- *(Superseded in Phase 4.)* The agent's availability is now `src/lib/agent/availability.ts`: the composer unlocks when the session is `ready` **and** the chosen model's API key is set.

## NLE Bridge (Phase 3)

**Decisions (the user, 2026-10-05):**
- VibeCut Agent has **its own CEP panel**, so it runs alongside VibeCut without the two sharing a request queue. It doesn't use VibeCut's `com.vibecut.connect`, and has no UXP half: the UXP plugin needs a UDT reload after every Premiere restart, which defeats automatic re-sync.
- Phase 3 ports the **connection layer** only. Phase 4a added markers and the playhead; the edit commands come in 4b alongside the agent tools that call them.

**Premiere panel** (`src-premiere-panel/`, bundle `com.vibecutagent.connect` 0.1.0):
- Adapted from VibeCut's panel 0.9.4. `host.jsx` keeps only the read functions; `bridge.js` allows only `status`, `sequence_info` and `read_sequence`.
- Its folder is `~/Library/Application Support/VibeCut Agent/host-bridge/premiere/` (override: `VIBECUT_AGENT_PREMIERE_BRIDGE_DIR`).
- `alive.json` now carries `instance`, which is new each time Premiere loads the panel. That id is how a Premiere restart is detected.
- Installed from Settings → Editors (`premiere_panel.rs`), which copies `PANEL_FILES` into `~/Library/Application Support/Adobe/CEP/extensions/`. Release builds ship it as the resource `premiere-panel/`.
- It needs CEP `PlayerDebugMode` = 1. The app reads that setting and never writes it.
- To add a command, update three places together: the `COMMANDS` and `CHECKS` maps in `bridge.js`, a `vc*` function in `host.jsx`, and `CALLS` in `watch.py`. Then bump the version in the manifest, `PANEL_VERSION` and the Rust test.

**Watchers** (`src-python/vibecut_agent/nle/`, standard library only):
- `premiere-watch` runs under uv. `resolve-watch` runs under Resolve's `ResolvePython`, which runs *isolated* (`-I`): it ignores `PYTHONPATH` and every `PYTHON*` variable. So Rust runs `src-python/resolve_watch.py` with `-u -B`, and that script puts the package on `sys.path` itself.
- Each watcher probes its editor every 2 s and emits `state` only on a change. The `reason` field is one of: `unavailable`, `connected`, `disconnected`, `reconnected`, `restarted` (new panel instance), `project_changed`, `timeline_changed`, `timelines_changed`.
- Between probes it answers `call` lines with `reply` events. `CALLS` = `status`, `read_timeline`.
- Resolve has no instance id, so a Resolve restart reads as `reconnected`.
- **Re-sync rule** (`needsResync` in `src/lib/nleStatus.ts`): after `connected`, `reconnected`, `restarted` or `project_changed`, anything read from that editor is stale.

**Supervisor** (`src-tauri/src/nle.rs`):
- Starts both watchers in `setup`. Resolve is marked `unavailable` when `ResolvePython` is missing.
- Relays `state` as `nle-state`.
- Routes `reply` events to pending `nle_call`s.
- Restarts a dead watcher with backoff (1, 2, 4… up to 30 s). After 5 starts in a row that never reached `ready`, it gives up until `nle_reconnect`.
- A generation counter keeps a watcher that is winding down from overwriting its successor's state.
- Every watcher is registered in `SidecarJobs`, so it dies with the app.

**Verified:**
- Unit tests: Python (bridge, both hosts, watcher), Rust, vitest. `bridge.js` runs in a Node sandbox with a fake CEP host.
- Live runs: `resolve-watch` under the real ResolvePython 3.14.4, from the repo and from inside the release bundle, with Resolve closed. The user's running dev build supervised both watchers plus the session.
- **Not yet verified live:** an actual Premiere or Resolve connection, because neither editor was running. To check:
  1. Install the panel from Settings → Editors, then restart Premiere. The pill should go green with project · timeline.
  2. Quit and reopen Premiere. The state should pass through `disconnected`, then `restarted`.
  3. Start Resolve Studio with external scripting set to Local. The state should be `connected`.

## Chat Agent & B-Roll (Phase 4)

**Decisions (the user, 2026-10-05):**
- The first cut of the agent's tools is **read + markers** for both editors. Direct edits come in 4b.
- The B-roll analyzer ships **with the optional ML "energy" extra**.

**Chat agent** (`src-python/vibecut_agent/agent/`, ported from VibeCut's rough-cut-studio):
- **Modules:** `gemini_chat.py` (Gemini over plain HTTPS with `requests`), `claude_chat.py` and `claude_client.py` (the `anthropic` 1.11.0 SDK, with VibeCut's beta flags), `chat_steps.py`, `claude_schema.py`, `redact.py`. `gemini_client.py` keeps only the transport helpers, and the unused vision helper `generate_json` was removed.
- **The conversation process:** `chat.py` is VibeCut's `run_chat`. One interactive `chat` process runs per conversation; the protocol is in its docstring. Rust's `prepare_request` injects `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` into the first request only. The UI never holds a key, and `redact.py` scrubs it from every error.
- **The app side** (`src/lib/agent/`):
  - `tools.ts`: eight tools — `list_timelines`, `list_timeline_clips`, `list_markers`, `add_markers`, `update_marker`, `remove_markers`, `get_playhead_time`, `set_playhead_time`. Descriptions and executors are ported from VibeCut; each runs on the timeline open in the editor, through `nle_call`.
  - `snapshot.ts`: VibeCut's `timelineLines`, put ahead of each message.
  - `prompt.ts`: VibeCut's ground rules cut to these tools. It tells the agent plainly what it can't do yet.
  - `controller.ts`: start/continue, answering `tool_calls`, Stop (`abort_turn`), New chat. A new job starts when the editor or model changes; a new provider also resets the history.
  - `availability.ts`: the composer unlocks when the sidecar is ready **and** the chosen model's key is set.
- **Tests:** VibeCut's chat tests run unchanged against the port (74), plus the controller, tools, snapshot and availability.

**Host commands added for these tools:**
- **Premiere panel 0.2.0:** `add_markers`, `update_marker`, `remove_markers`, `get_playhead`, `set_playhead`, with `host.jsx` functions identical to VibeCut's and new `CHECKS`. **Users with panel 0.1.0 must press Update panel in Settings and restart Premiere.**
- **Both hosts:** `list_markers` and the methods above in `nle/premiere.py` and `nle/resolve.py`, plus `CALLS` in `watch.py`. VibeCut's 17 marker and playhead tests are ported.

**B-roll analyzer** (`src-python/vibecut_agent/broll/`, ported from VibeCut's broll-analyzer; its Spyglass search came in Phase 5):
- **Modules:** `analyzer.py`, `pipeline.py`, `vision_energy.py`, `semantic.py`, `result_cache.py`, `xml_export.py`, `ffprobe_util.py`. `commands.py` is VibeCut's `headless.py` with `analyze` (including catalog mode) and `match`; the contracts are in its docstring.
- **Dependencies:** the base set in pyproject (OpenCV, numpy, Pillow) and the `energy` extra (torch, torchvision, open_clip, transformers; about 2 GB). Rust adds `--extra energy` only for `broll-match`, or for `broll-analyze` with `enableEnergy` (`extras_for`). The SigLIP 2 weights download from Hugging Face on first use; this is disclosed in Settings and About.
- **Results** are cached per folder (`.broll_analyzer_cache.json`, embeddings in `.npz`, `.broll_semantic_index.json`), as VibeCut does.
- **Code quality:** VibeCut wasn't written for strict mypy, so `vibecut_agent.broll.*` has a scoped mypy override (bodies are still checked; annotation coverage is off) and ruff per-file ignores for its deliberate broad excepts. These are recorded as debt rather than rewriting tested code.
- **UI** (`components/broll/`): folder picker, a content-aware toggle with the download disclosure, brief and dedupe options, a progress bar with % and ETA plus Cancel (AGENTS.md §8), ranked clips with their best window and Show in Finder, and a text search with content-aware scoring on. VibeCut's 205 analyzer tests are ported.

**Verified:**
- Every unit suite passes.
- A live `broll-analyze` run, launched exactly as Rust launches it, on three generated clips: deterministic progress, a ranked result and a written cache, in about 1 s.
- The release bundle contains `agent/` and `broll/`.

**Not yet verified live:**
- A real model call. There's no `.env` here; add one and send a message.
- The `energy` extra's 2 GB install and model download. Turn content-aware scoring on and run once.
- The agent against a running Premiere or Resolve.

## Direct Edits (Phase 4b)

**What the agent can do now** (both editors, on the open timeline):
- add_clips (file paths into free space; never overwrites)
- delete_clips, set_clips_enabled, set_clip_levels
- set_clip_fade, split_clip
- trim_clip_start, trim_clip_end, slip_clip, move_clip
- nest_clips, duck_music
- revert_timeline_edits

The B-roll panel's **Place** puts a pick's best stretch at the playhead the same way.

**Port** (VibeCut's tested modules, copied whole and pruned):
- **Premiere:** `nle/premiere_edit.py`, `premiere_effects.py` (fades, duck), `premiere_timing.py` (split).
- **Resolve:** `nle/resolve_edit.py`, `resolve_effects.py` (fades, plus transitions for the duck), `resolve_timing.py` (split), `resolve_reshape.py` (trim/slip/move; carries the grade through `carry_grades`).
- **Helpers:** VibeCut's rebuild, pool and colour modules aren't imported. The helpers the edits need were copied into `premiere_support.py` and `resolve_support.py` (the Resolve one is stdlib-only, since it runs under ResolvePython).
- **Dispatch:** `edits.py` maps commands to functions per editor. Each watcher adapter has its own allow-list (`calls`).
- **Not ported:** captions, speed, track add/remove, Premiere transitions, colour, link and track options. `revert_timeline_changes` validates against `REVERTIBLE` and refuses those kinds up front.
- **Panel 0.3.0:** gains 12 commands (`backup_sequence`, `place_clip`, `remove_items`, `nest_range`, `set_items`, `move_items`, `link_items`, `add_tracks`, `remove_tracks`, `read_fades`, `set_fades`, `razor`).
  - Their `host.jsx` code is VibeCut's, chosen by a dependency closure: 33 functions and variables, byte-identical. Their `CHECKS` are copied verbatim.
  - **`add_tracks`, `remove_tracks` and `razor` use Premiere's unsupported QE layer**, as VibeCut does (checked live by VibeCut on 26.5.2).
  - Users must press **Update panel** and restart Premiere.

**The app owns the edit log** (`useEditLogStore`, in memory like VibeCut's):
- `lib/agent/edits.ts` ports VibeCut's `edit()`. It makes the backup once per request (`"<name> (before VibeCut n)"`), refuses edits on locked tracks after a fresh read (Premiere's scripting would edit them anyway), runs the edit, follows `renamed` ids, and logs the changes.
- `revertTimelineEdits` sends each entry back newest first, with ids followed through `restoredIds`.
- The chat header's **Revert n edits** reverts the latest request (or B-roll placement).
- Each snapshot carries `editLogContext()`, so the agent can revert by id.
- **After an app restart the log is gone.** The backup copies in the editor are then the way back.

**Differences from VibeCut:**
- No drafts, Media Pool ids or editor selection. Ripple edits are refused, clips are added by path, and fades and splits name their clips (or split under the time).
- `duck_music` has no transcripts. It ducks under where the dialogue clips sit (`dialogueClipIds`, default every other sound clip) or under explicit `spans`, and its description says so.

**Tests:**
- 63 of VibeCut's edit tests ported (Premiere edit, effects and timing; Resolve edit, effects, timing and reshape), against its own test doubles (`tests/nle/vibecut_*`, with `tests/nle/compat.py` for `run_command`).
- Frontend: the edit wrapper, revert, every executor, the duck on both editors, the Revert button and Place.
- Lint and types: the vendored edit modules share the B-roll package's scoped mypy profile (bodies are checked); the 22 real type findings were fixed.

**Verified live (2026-10-05, with the user's go-ahead, on scratch copies):** every edit went through each watcher's real JSON-lines protocol, then was reverted newest first with the app's id-following, and the timeline was compared clip by clip with its start.
- **Resolve Studio 21.1.0.17** (project "VibeCut 7a", on a duplicate of "Bakery"):
  - Each edit worked: level −6 dB, picture off, 1 s fade-in, split at 10 s (picture and sound together), delete leaving a gap, `add_clips` of a 3 s piece at 26 s, trim to 8 s, and nest into a compound clip.
  - A duck-style run also worked: split, the piece turned down to −12 dB, and `set_transition`, which made Resolve's 0.32 s "Cross Fade +3 dB" on the cut.
  - All 11 reverts succeeded, and the timeline came back identical.
  - The test timelines and the test compound clip were deleted afterwards, and "Timeline 28" was reopened.
  - Note: `CreateCompoundClip` leaves its compound in the Media Pool even after Revert takes it off the timeline.
- **Premiere Pro 26.5.2, panel 0.3.0** (project "VibeCut Roundtrip 105027", on a clone of "Bakery 7a"):
  - Each edit worked: level, picture off, fade, split (the QE razor), delete, `add_clips` at 26 s, and trim.
  - Nest on a sequence that isn't open was refused as designed ("open it to nest").
  - All 7 reverts succeeded, and the sequence came back identical.
  - Keyframes read through the panel: the fade-in made Opacity keys 0 → 100 over 1 s. The duck made Level keys 0.178 → 0.045 (exactly −12 dB) at 5–8 s with 0.32 s ramps. After Revert, no keyframes were left.
  - The panel can't delete sequences, so "VibeCut Agent test (Bakery 7a)" and its "(before VibeCut 1)" backup remain in that project for the user to delete.

## Spyglass B-roll Library (Phase 5)

**Why (the user, 2026-10-05):** the B-Roll tab was meant to be VibeCut's in-editor B-roll panel: search Spyglass's index of the archive (Rough Cut Studio Suite - Blair Themed), scope the agent's B-roll searches, preview shots and click or drag them into Premiere or Resolve. Phase 4 had ported only the folder analyzer. **Decisions:** keep the analyzer as it is; add the Library with Import, Source preview, the pool and the agent's find_broll tools.

**The index:**
- Read only, from Rust (`spyglass.rs`, `spyglass_archive.rs`, ported from VibeCut; `rusqlite` bundled) and from Python (`broll/spyglass_index.py`).
- **Lookup order:** `VIBECUT_SPYGLASS_INDEX`, then the file chosen in Settings → B-roll Library (saved as `spyglass.json` in the app config folder), then `~/Library/Application Support/edu.blair.spyglass/spyglass_index.sqlite`.
- **On this Mac:** `~/.zshenv` sets `VIBECUT_SPYGLASS_INDEX` to Blair Themed's own index at `…/Rough Cut Studio Suite - Blair Themed/apps/suite-wrapper/assets/spyglass/spyglass_index.sqlite`. The `~/Library` copy is an older one (Sep 8). A release app opened from Finder doesn't see `.zshenv`, so choose the Blair Themed file in Settings.
- **One index:** Rust writes the resolved path into every `broll-spyglass` request (`set_index_path`), so the search always reads the same file as the folder tree.

**UI** (`components/broll/`):
- `BrollPanel` switches between **Library** (`LibraryPanel`) and **Folder** (`FolderAnalyzer`, the Phase 4 panel, unchanged).
- **Folders:** a tree with checkboxes; the ticked folders are the scope.
- **Search:** Spyglass's own hybrid ranking (`broll-spyglass`, top 40). An empty box browses the scope, 60 shots a page, with More.
- **Shot cards:**
  - Keyframe. **Double-click it** to open the shot in the editor's source viewer.
  - Pool / Source / Import / Place buttons.
  - The card **drags** as the whole clip file.
  - Keys: Space/Enter Source, P Place, I Import, A Pool, arrows move between cards.
- **Pool tray:** reorder, Source, Place, Import all, Clear.
- **Remembered:** the scope and pool (`useLibraryStore`, localStorage). Logic is in `lib/library.ts`, a port of VibeCut's `panelBroll.ts`.

**Editor actions:**
- **Source** (`source_preview`):
  - **Premiere:** `sourceMonitor.openFilePath` with In/Out marked and the playhead at In; nothing is imported.
  - **Resolve:** imports into the bin first (only Media Pool clips can be shown), marks In/Out, and selects the clip. The Edit page shows it; Shift+I goes to In.
- **Import** (`import_media`): into a top-level **"VibeCut B-roll"** bin; files already in the project are reused. Imports aren't timeline edits, so they aren't in the edit log and Revert doesn't remove them.
- **Place:** `placeAtPlayhead(…, { sound: false })`, picture only, as its own revertible request.
- **Drag:** `spyglass_start_drag` (synchronous, so it runs on the main thread) → `native_drag::start_file_drag`, with a 160 px icon made from the keyframe and prepared ahead by `spyglass_prepare_drag`. The webview's own drag is cancelled in `dragstart`.
  - `native_drag.rs` is adapted from drag-rs (MIT/Apache), which replaced it. drag-rs offers only one drag operation, Copy, and Premiere's timeline showed no insert indicator and took no drop (live, 2026-10-06), consistent with a target that links to media asking for Link or Generic.
  - The drag now offers Finder's operations (Copy | Link | Generic, not Move), with the file on the pasteboard through `NSURL`'s own writer.
- **Premiere panel 0.4.0:** `vcImportMedia` (on `vcFindMedia`, split out of `vcProjectItemFor`) and `vcSourcePreview` / `vcSourceTimecode` (from VibeCut, verbatim), with their `CHECKS`. **Update panel in Settings, then restart Premiere.**
- **Watchers:** `nle/media.py` (stdlib only) adds `import_media` and `source_preview` to both adapters' `calls`.

**Agent** (`lib/agent/spyglassTools.ts`, from VibeCut's `chatSpyglassTools.ts` / `find_broll`):
- `find_broll` searches the Library's ticked folders unless the agent names `spyglassFolders`, and its matches show in the Library ("The agent's search").
- `list_spyglass_folders` and `describe_spyglass_folder`.
- The prompt gains `BROLL_SCOPE_INSTRUCTION`. The agent places a match with `add_clips` (path, sourceIn/sourceOut).

**Tests:**
- Rust: the 15 ported spyglass/spyglass_archive tests, plus `shot_file`, the chosen-index order and `set_index_path`.
- Python: 80 ported Spyglass tests, plus `tests/nle/test_media.py`.
- bridge.js: the import and preview CHECKS.
- vitest: `library.test.ts`, `LibraryPanel.test.tsx`, `spyglassTools.test.ts`.

**Verified:**
- The Rust reader against the real Blair Themed / Spyglass index: 3 roots, about 17k shots, read in about 250 ms.
- A live `broll-spyglass` run on 400 real clips (SigLIP 2) returned ranked matches.

**Fixed after the first live try (2026-10-05):** "drag and double-click do nothing in Premiere" was every shot being offline. All 12,134 indexed clips sit on the Blair archive drives (`2024 Main Drive - Blair`, `2026 Main Drive - Blair`, `Blair 2223`), none of them was mounted, and offline cards turned drag and double-click off without a word.
- Now a drag or double-click on an offline shot names the drive to attach (`unusable`, `driveOf`).
- The Library shows an "attach these drives" line (`missingDrives`).
- Folder online state is rechecked every 10 s and when the window gets focus (`recheckDrives`, `DRIVE_RECHECK_MS`), so a drive attached or ejected after the Library opened shows here and in the Premiere panel without a restart. A browsed page with shots under a changed folder is read again; a search is not re-run.
- The thumbnail is a plain element, not a `<button>`, so grabbing it starts the card's drag (WebKit won't start a drag from a form control).
- `source_preview` was then sent straight through the live 0.4.0 panel on a local clip: `{marked: true, atIn: true}`.

**Not yet verified live:**
- Source, Import, Place and drag in each editor (they change the open project). To check:
  1. Settings → Editors → Update panel, then restart Premiere.
  2. In Library, tick a folder whose drive is attached and search.
  3. Double-click a thumbnail: Premiere's Source monitor should open with In/Out marked.
  4. Import should land in "VibeCut B-roll". Place goes at the playhead, and Revert removes it.
  5. Drag a card into the Project panel, then onto the timeline.
  6. Repeat in Resolve (Media Pool, source viewer on the Edit page).
- Whether Premiere and Resolve accept the drag from a Tauri window the way they accept one from Finder (they should; it's a standard `NSFilenamesPboardType` file drag).

## The B-roll Panel in Premiere (Phase 5b, 2026-10-06)

**Why (the user):** dragging from VibeCut Agent's window never worked in Premiere's timeline. That held even after the drag offered Finder's operations: there was no insert marker and no drop. The user asked for it to "work the same way the Premiere Pro VibeCut B-roll extension panels handle drag and drop and preview". VibeCut never drags from its desktop window: it docks a CEP panel, "VibeCut B-roll", in Premiere. Premiere takes a file dragged from a CEP panel (`com.adobe.cep.dnd.file.0`) into the Project panel or timeline, with its insert marker.

**What it is:**
- The panel bundle (`com.vibecutagent.connect` **0.6.0**) gains a visible, dockable second extension, **VibeCut Agent B-roll** (`com.vibecutagent.connect.broll`, Window → Extensions).
- It is the B-roll Library inside Premiere:
  - folders and scope, shared with the app and the agent's `find_broll`;
  - search and browse;
  - shot cards with thumbnails, Pool / Source / Import / Place;
  - **double-click a card** to open it in the Source monitor with In/Out marked;
  - **drag a card** (or a pool row) into the Project panel or the timeline, as the whole file.
- It is VibeCut's `src-host-panel` B-roll tab (`Broll.tsx`, `BrollApp.tsx`, `Press.tsx`, `cep.tsx`, the file transport, `panel.css`), cut to the B-roll tab, in `src-premiere-panel-ui/`.
- `npm run build:panel` (`vite.panel.config.ts`; also part of `npm run build`) writes `src-premiere-panel/broll/dist/panel.{js,css}`. `PANEL_FILES` and the release resources include them.

**How it talks to the app:** files, as VibeCut's chat panels do (no network port), in `~/Library/Application Support/VibeCut Agent/host-bridge/broll/premiere/`. This is its own folder, never VibeCut's.
- **`broll.json`:** written by the frontend (`src/lib/brollPanel.ts`, after VibeCut's `panelBroll.ts`) whenever the Library or Premiere's state changes.
  - It holds folders in tree order, shots, pool, scope, busy/error, and an `editor` block (Premiere connected? why Source/Import or Place waits).
  - It holds a `notice` naming the action it answers.
  - It holds `paths` for usable shots only, for the drag.
  - Shared types: `src/types/brollPanel.ts`.
- **`inbox/<id>.json`:** the panel's actions. `src-tauri/src/broll_panel.rs` (VibeCut's `host_chat.rs`, cut to the B-roll actions):
  - checks and rebuilds each action from its allowed fields;
  - deletes it;
  - emits `broll-panel-action`;
  - stamps `agent-alive.json` every second.
- **What the app does with an action:** it answers with the Library's own functions, aimed at **Premiere** (`importShots` / `previewShot` / `placeShot` with `only = "premiere"`), and acts on a folder only if it listed it.
- **`thumbs/s<id>.txt`:** `broll_panel_thumbs` writes each keyframe scaled to 240 px as a JPEG `data:` URL, using the `image` crate instead of VibeCut's ffmpeg. It keeps the newest 800.

**Verified live (2026-10-06), against the running app, the real Blair Themed index, and Premiere 26.5.2, with a script standing in for the panel:**
- A `hello` made the app publish the "2026-2027" scope: 675 shots, the first 60 with drag paths, connected to Premiere.
- 60 thumbnails were written.
- A `broll_source` was answered in 1.0 s with the shot open in the Source monitor, In/Out marked.

**Not yet verified live:** the panel itself inside Premiere and its CEP drag. It needs Settings → Editors → **Update panel** (0.6.0) and a Premiere restart, then Window → Extensions → VibeCut Agent B-roll.

**The app window's own drag stays:** `native_drag.rs` may suit Resolve, which takes Finder drags into its Media Pool. That is untested; VibeCut used Resolve's Electron plugin there.

## Phase 6: An Agent That Can Build a Video

**Why (the user, 2026-10-06):** asked to cut interviews into a 2-minute edit with archive B-roll, the agent refused: it couldn't sync audio, read the Project panel, or make or switch sequences.

**Decisions (the user):**
- Port all four of VibeCut's missing capability groups, **phase by phase**, each handed over for a live try: 6a project & sequences, 6b transcripts & text cuts, 6c audio sync, 6d Story Editor.
- The Story Editor uses the chat's model (Gemini or Claude).
- Speaker detection is included, as optional.

**Approach:** keep VibeCut's tested Python, `host.jsx` and pure TypeScript; rewrite only the thin adapters that VibeCut tied to its own editor stores.

### 6a: Project & sequences (done 2026-10-06)

**Tools** (`src/lib/agent/projectTools.ts`, from VibeCut's `hostProject.ts`, `poolRead.ts` and `poolSpec.ts`):
- Timelines: `create_timeline`, `duplicate_timeline`, `switch_timeline`, `rename_timeline`, and a richer `list_timelines`.
- Selection: `select_clip` (Resolve moves its playhead instead) and `select_media_assets`.
- The pool: `list_media_pool`, `get_clip_info`, `search_media_pool`.
- `import_media`, on Phase 5's `media.py`.

**VibeCut's rules, kept:**
- The agent works on one **connected** timeline. Creating or duplicating opens the new one and connects to it.
- It switches freely to timelines it made, but to one of the user's only when the user's message names it.
- It renames only timelines it made.
- It never touches the "(before VibeCut n)" backups.

**The connected timeline can change mid-turn:**
- The executors move `ToolContext.timeline`.
- `executorsFor` builds each edit for the timeline connected when it runs, so a `create_timeline` followed by `add_clips` in the same turn builds the new sequence. Its first edit still makes a backup, as in VibeCut.

**State** (`src/store/useConnectionStore.ts`), per editor:
- `madeTimelines`.
- The last pool read.
- Short pool ids (`p1`, `p2`…), kept for the connection.

It starts over when the editor's project changes (`forProject`).

**Snapshot:** each message now also carries the pool block (VibeCut's `poolContext`: up to 80 clips, logged notes, the selection), read with `read_media_pool`.

**Host side:**
- **Python modules:** `nle/premiere_project.py`, `premiere_pool.py`, `resolve_project.py` and `resolve_pool.py` are VibeCut's, with imports pointed at `premiere_support` / `resolve_support`, so there is no rebuild/OTIO dependency.
  - Their import functions were dropped, since `media.py` owns imports.
  - `resolve_pool.py` also carries Resolve's own `get_transcripts` / `transcribe_clips`, which are registered in 6b.
- **Dispatch:** `nle/project.py`, added to both watchers' `calls`.
- **Type checking:** a scoped mypy entry for the four modules; their 6 real annotation gaps were fixed.

**Premiere panel 0.5.0:**
- New `host.jsx` pieces, by dependency closure, verbatim from VibeCut:
  - `vcCreateSequence`, `vcDuplicateSequence`, `vcOpenSequence`, `vcRenameSequence`
  - `vcSelectItems`, `vcSelectProjectItems`
  - `vcReadProject` with its helpers: `vcReadProjectItem`, `vcColumnsOf`, `VC_COLUMNS`, `vcIsSequenceItem`, `vcUsage`, `vcProjectSelection`, `VC_MAX_PROJECT_ITEMS`
  - `vcProjectItemInfo`
- Every helper they share with the existing panel was checked byte-identical.
- `bridge.js` gains VibeCut's `CHECKS` (`SEQUENCE_PRESET` and the rest), plus `timeline` checks on each new command.
- `read_project` has a 25 s timeout.
- `create_timeline` uses Premiere's own HD 1080p preset nearest the connected sequence's frame rate (`VIBECUT_PREMIERE_PRESETS` overrides it).
- **Users must press Update panel, then restart Premiere.**

**Tests:**
- Ported from VibeCut: `test_premiere_project.py`, `test_premiere_pool.py`, `test_resolve_project.py`, `test_resolve_pool.py` (35, with `tests/nle/vibecut_premiere/premiere_fakes.py`).
- `projectTools.test.ts` (10), and bridge CHECKS.

**Verified live on Resolve Studio 21.1.0.17, project "VibeCut 7a", through a real `resolve-watch`:**
- `status`, `read_media_pool` and `search_media_pool`.
- `create_timeline` made "VCA 6a test" at 25 fps; `rename_timeline` and `duplicate_timeline` worked.
- `open_timeline` went back to "Timeline 28".
- `select_pool_clips` and `get_clip_info` worked.
- Both test timelines were deleted afterwards, and "Timeline 28" is current again.

**Not yet verified live:** Premiere (it needs panel 0.5.0 and a restart).

### 6b: Transcripts and cuts by what's said (done 2026-10-06)

**Transcribing:**
- **The `transcribe` command** (`vibecut_agent/transcribe/`) is VibeCut's interview-transcriber: `pipeline.py` verbatim, and `commands.py` from its `headless.py`.
- **How it runs:** mlx-whisper on Apple Silicon, small model by default.
- **Where transcripts go:** the shared `<media>.ivt-cache.json` next to each file, which VibeCut and its suite read too.
- **Extras:** pyproject `transcribe` (mlx-whisper 0.4.3, mlx 0.32.0) and `diarize` (pyannote.audio 4.0.7, torch, torchaudio).
- **Speaker labels:**
  - They need a Hugging Face token: Settings → API keys, a third provider `huggingface` / `HF_TOKEN` in `secrets.rs`.
  - Rust puts the token into a `transcribe` request only when it labels speakers (`set_hf_token`), and strips any the UI sent. VibeCut read it from the environment or its own Keychain item instead.
- **Verified live:** a spoken test clip transcribed with word timings, including its "um" and "uh".

**Reading transcripts:** `transcript.rs` is VibeCut's verbatim, with its 15 tests: freshness by size and modification time, speaker labels, and switched-off speakers.

**The draft** (VibeCut's rule: cuts never ripple the user's timeline):
- **VibeCut's pure modules, verbatim with their 86 tests,** are in `src/vibecut/`:
  - `hostDraft.ts`, `transcriptLane.ts`, `speakers.ts`, `silence.ts`, `wordMatch.ts`, `timeRemap.ts`, `chatArgs.ts`;
  - the pure half of `chatContentTools.ts` as `contentTools.ts`;
  - their types;
  - slim `timeline.ts` / `sidecarResults.ts` holding just what they use.
- `src/lib/agent/draft.ts`:
  - opens a draft from the connected timeline and keeps it in `useConnectionStore`;
  - `remove_time_ranges` and `rearrange_sections` change it;
  - `send_to_premiere` / `send_to_resolve` → the watcher's `rebuild` → a NEW timeline, which the agent connects to;
  - `discard_draft` drops it.
- **While a draft is open:** direct edits, `create_timeline`, `duplicate_timeline` and `switch_timeline` are refused, and the snapshot shows the draft.
- **Chat panel:** a draft bar with Send / Discard.

**Rebuild:**
- `nle/premiere_rebuild.py` and `nle/resolve_rebuild.py` are VibeCut's, with rough-cut-studio's `xml_builder`, `otio_builder` and `time_remap` vendored in `nle/interchange/` (standard library only, so they run under ResolvePython), and ffprobe through `broll/ffprobe_util.py`.
- **Premiere panel 0.7.0:**
  - `vcImportSequence` (VibeCut's, verbatim) is added.
  - `bridge.js` imports only from its own `imports/` folder.
  - `import_sequence` has a 170 s timeout.
- **Ported tests:** `test_premiere_rebuild`, `test_resolve_rebuild`, `test_xml_builder_timeline`, `test_otio_builder_timeline`.

**Tools** (`src/lib/agent/transcriptTools.ts`, from VibeCut's `hostTranscripts.ts` and `hostReview.ts`):
- **Reading and transcribing:**
  - `get_transcript`: the timeline's or draft's lines, or, with `clipId` / `filePath`, one file's transcript in file time, for footage not on a timeline yet.
  - `transcribe_clips`: timeline clips, project clips (`p3`) or paths. Speakers are labelled by default when a token is set.
  - `search_transcript`.
- **Cutting (into the draft):** `remove_transcript_lines`, `remove_speaker_lines`, `find_filler_words`.
- **Silences:** `find_silences`, measured by the new `audio-peaks` sidecar command (ffmpeg → VibeCut's peak format), which replaces VibeCut's Rust waveform cache.
- **Speakers:** `list_speakers`, and `set_speaker_roles`, whose roles are kept for the connection and confirmed only by what the user actually typed.
- **How the timeline is read:** `hostClips` is VibeCut's `hostLintTimeline`, which hears only audio clips with a file. Files are known by a short FNV-1a `fileKey`, so line ids stay short.

**Verified live (Resolve Studio 21.1, "VibeCut 7a", through a real `resolve-watch`):**
- A `rebuild` made "VCA 6b rebuild test": 4 clips, linked in pairs, the cut at 3 s, and 1 marker.
- An over-long cut was refused first ("only 6.68 s long").
- The timeline and its imported clip were deleted afterwards, and "Timeline 28" is current again.

**Not yet verified live:**
- Premiere's rebuild (it needs panel 0.7.0 and a restart).
- The agent driving the whole flow with a model.

### 6c: Audio sync (done 2026-10-06)

**The engine:** `src-tauri/src/audiosync.rs` is VibeCut's waveform matcher, verbatim:
- ffmpeg onset envelopes, a coarse cross-correlation, then a sub-sample refinement with a drift estimate.
- Envelopes are cached in the app cache's `audiosync/` folder and pruned at launch.
- Commands: `sync_audio` (with `audio-sync-progress` events) and `cancel_audio_sync`.
- **Offset convention (A-Sync's and VibeCut's):** camera time = recorder time + offset.

**Tools** (`src/lib/agent/syncTools.ts`, from VibeCut's `hostSync.ts` and `src/vibecut/lib/sync.ts`):
- **`sync_and_place` (new here):** matches camera files to recordings, then lays out each camera the way VibeCut does: picture on V1, the recording's matching stretch on A1, and the camera's own sound kept but switched off, all linked. Cameras follow one another from `at` (default: the timeline's end). A camera that matches nothing is skipped and named.
- **`sync_clips`:** for linked picture and sound already on the timeline. Finds the offset, then slips the sound into sync (unless `slip: false`).
- **`slip_into_sync`:** puts linked sound back in sync without moving the picture.
  - The picture's own sound goes back to offset 0.
  - A separate recording uses the offset found this connection, else A-Sync's `<video>.sync-offsets.json` (`read_suite_sync`).
  - Premiere's split-stereo channels are slipped once, together.
- **`link_clips` / `unlink_clips`:** `set_links` (`links.py`, Premiere's `vcSetLinks`).
- Every step goes through the edit path: backed up, logged, revertible.

**State:** offsets found are kept per connection (`syncOffsets` in `useConnectionStore`).

**Differences from VibeCut:** sync is refused while a draft is open. VibeCut slipped inside the draft instead; here sync is a direct edit.

**Premiere panel 0.8.0:** `vcSetLinks`, and `set_links` in `bridge.js`.

**Fixed while verifying:**
- **Revert of a link change** now follows replaced clip ids inside `groupsBefore` / `groupsAfter` (`followed` in `edits.ts`). A Resolve slip replaces the clip, so reverting the earlier link reported "changed since".
- **A slip the editor refused** is now reported as a problem; before, it counted as slipped.

**Tests:**
- `syncTools.test.ts` (16), on VibeCut's `hostSync` fixture.
- A `followed` case for link groups.
- `cargo test -- --ignored real_footage --nocapture` runs the engine on real files (`VIBECUT_SYNC_CAMERAS`, `VIBECUT_SYNC_RECORDERS`).

**Verified live (Resolve Studio 21.1, "VibeCut 7a", through a real `resolve-watch`):**
- **Footage:** a generated pair sharing one noise track, with the camera starting 6.25 s into the recorder. The engine found −6.250 s (refined, confidence 0.57, no drift).
- **The edits:** `sync_and_place`'s calls placed V1 camera, A1 camera sound off, and A2 recording from 6.24 s, all linked. Unlink, then relink, worked.
- **Resync:** after a 0.4 s knock, `slip_into_sync`'s slip brought the sound back to 6.24 s, with the picture unmoved.
- **Frame rounding:** Resolve rounds to whole frames, so sync is frame-accurate. At 25 fps it was within 10 ms, below `IN_SYNC_SECONDS`.
- **Revert:** all 8 changes reverted, newest first, and the timeline came back identical.
- **Cleanup:** the test timelines, their backups and the two imported clips were deleted, and "Timeline 28" is current again.

**Not yet verified live:** Premiere (it needs panel 0.8.0 and a restart), and real dual-system footage.

### 6d: Story Editor (done 2026-10-06)

**What it does:** `run_story_editor` makes a story cut from interview transcripts, optionally with B-roll, in one call to the chat's own model. The cut opens as a draft, and `send_to_premiere` / `send_to_resolve` makes it a new timeline. The connected timeline is never changed.

**Decisions (the user):** the chat's model (Gemini or Claude), and **no music bed** for now. VibeCut's beat-snapping (`ensureBeats` / `musicSync`) can follow as its own step.

**The `assemble` sidecar command** (`vibecut_agent/story/`, a slim port of rough-cut-studio's `Api.assemble` and `headless.py run_assemble`):
- **`prompt.py`:** `SYSTEM_INSTRUCTION`, `STORY_SYSTEM_INSTRUCTION`, `STORY_RESPONSE_SCHEMA` and the two prompt formatters, verbatim. Both models get the same brief.
- **`models.py`:**
  - **Gemini:** `generate_story_script` on the chat's transport helpers (`gemini_client.py`).
  - **Claude (new; VibeCut's was Gemini only):** the same system and user text, answered through structured outputs (`output_config.format`, a `json_schema` from `claude_schema.strict_schema`). It goes through `claude_client.send`, with refusal fallbacks (`fallbacks: "default"`) and effort `high`. Refusal and `max_tokens` stops are reported, and forced tool use isn't used (these models refuse it).
- **`assemble.py`:** VibeCut's checks, verbatim in behaviour:
  - Inline transcripts load with malformed lines skipped.
  - Every main pick is checked against the transcript; a trim under 0.3 s falls back to the whole line, and a repeated line is kept once.
  - B-roll ids are checked against the catalog and anchored by the model's own `order`; durations are clamped to the clip.
  - **New here:** a warning when the cut misses `targetDuration` by more than max(10 s, 25%), and "a 2-minute cut" is read as a duration.
  - It emits the same `result` event as rough-cut-studio's `_finish`.
- **Left out:** the Script/XML/FCPXML/OTIO files (`rebuild` writes the interchange), project history, drop-frame timecode, and the generation lock.
- **Keys:** `assemble` is in both allow-lists. `needs_llm_key` in `sidecar.rs` gives it the chat provider's key from the environment or the Keychain; the UI never holds a key.

**The tool** (`src/lib/agent/storyTools.ts`, from VibeCut's connected-editor `runStoryEditor`):
- **Files:** those of `clipIds` (timeline or `p3`), else every file with sound on the connected timeline. Files with no transcript are named and left out.
- **Transcripts:** read through `transcript.rs` with the speaker names and roles saved this connection (`withSpeakers`).
- **The interviewer:** left out unless the brief asks for the questions (`briefWantsInterviewer`). A speaker switched off in the transcriber counts as the interviewer.
- **Caps:** at most 2,000 lines and 500 catalog entries (`capTranscripts`, `capCatalog`).
- **B-roll:**
  - `brollBin` / `brollClipIds`: project clips, with their logging as the caption (VibeCut's `poolCatalog`).
  - `brollFromLibrary` (new): the on-line shots in the B-roll Library's ticked folders, with Spyglass's caption and tags, one entry per shot. Each shot is placed from its own start in the file (`withBrollOffsets`).
- **The model:** the chat's choice (`aiChoice`). Stop cancels the running job.
- **The draft:** `roughCutPlan` → `draftFromPlan`: main cuts on V1/A1, linked; B-roll on V2 (A2 unless silent).
- **What isn't carried:** ducking under B-roll (`notCarried` says so).
- **Ported pieces:** `storyEditorContext.ts` (VibeCut's, with `storySourceOf` replacing its store-bound `gatherProjectTranscripts`, and without `buildBrollCatalog`), and `roughCutPlan` / `roughCutSummary` in `sidecarResults.ts`.
- **Prompt:** the system prompt now offers the Story Editor; it no longer says "can't do yet".
- **About:** says a Story Editor cut sends the interviews' transcripts to the chosen provider.

**Tests:**
- Python: `tests/story/` (43), with rough-cut-studio's `test_api_assemble.py` cases ported. They cover both providers' requests (the strict schema for Claude), refusals, bad requests, the catalog in the prompt, and that the key never appears in an event.
- Frontend: `storyEditorContext.test.ts` (12) and `storyTools.test.ts` (10).
- Rust: the key injection for `assemble`.

**Verified live (2026-10-06):**
- **Footage:** two spoken test interviews (macOS `say`: a founder, 24 s, and a baker, 22 s, each with an off-topic line), transcribed by the real `transcribe` command (7 and 6 lines).
- **The real `assemble` with Gemini (`gemini-flash-latest`) and with Claude Opus 5.5:**
  - The brief was "how the bakery began and what keeps people coming back", 30 s target.
  - Both models chose the same 9 lines in story order (29 s) and skipped both off-topic lines.
  - Claude's structured output parsed with no warnings.
- **Into Resolve:** the result became a draft with `draftFromPlan`, and the real `rebuild` through `resolve-watch` made "VCA 6d story test" in Resolve Studio 21.1 ("VibeCut 7a"): 18 clips (V1 + A1, linked in pairs), 29 s, on frame boundaries.
- **Cleanup:** the test timeline and its two imported clips were deleted, and "Timeline 28" is current again.

**Not yet verified live:** the chat driving it end to end with a model, B-roll in a live cut, and Premiere (panel 0.7.0+ and a restart).

## Phase 7: Claude Without an API Key — built 2026-10-06 (7a, 7b, 7d); live checks in the editors pending

**Why (the user, 2026-10-06):** use Claude as the editing agent on the user's own Claude subscription, with no API key, both from the app's chat and remotely from another device.

**Decisions (the user):**
- Build **7a** (an MCP bridge to the agent's tools), **7b** (a "Claude (subscription)" provider in the chat that runs the user's own Claude Code CLI) and **7d** (remote use through Claude Code's Remote Control).
- **7c** (Claude desktop) is not planned. With 7a in place it would only be a "Copy config" button.
- **Personal use only.** A subscription login may only be used by the person who owns it. A build handed to someone else keeps the API-key providers.

**The idea:** today the chat sidecar only *decides* which tools to call; the frontend runs them (`controller.ts` → `runTool` → `nle_call`). An MCP server can stand in as the decider's door. Any MCP client (the app's own Claude Code run in 7b, an interactive Claude Code session in 7d) then calls the very same executors, with the same snapshot, backup, edit log and Revert.

### 7a: The MCP bridge

**Shape (one new boundary; files, no network port, like the B-roll panel):**

```text
MCP client (claude -p in 7b, interactive claude in 7d)
   │ stdio MCP
   ▼
vibecut_agent/mcp_server.py  (Python shim, launched by the client)
   │ files: requests/<id>.json → replies/<id>.json
   ▼
src-tauri/src/mcp_bridge.rs  (drain, check, emit `mcp-request`; `mcp_reply` writes the reply)
   ▼
src/lib/mcp/server.ts  (webview) → executorsFor(...) / runTool → nle_call → editors
```

**Folder:** `~/Library/Application Support/VibeCut Agent/host-bridge/mcp/` (override `VIBECUT_AGENT_MCP_DIR`, for tests and parallel dev builds), mode `0700`:
- `requests/<id>.json`: `{ id, caller, kind: "list_tools" | "call_tool", name?, args? }`, written by the shim and renamed into place. `caller` is the chat job id for 7b, or `"outside"`.
- `replies/<id>.json`: `{ id, ok, result | error }`, written by the app through `mcp_reply` and deleted by the shim once read.
- `agent-alive.json`: stamped every second by the app. It records whether outside control is allowed, so the shim can tell "VibeCut Agent isn't running" from "outside control is off".

**Rust `mcp_bridge.rs`** (modelled on `broll_panel.rs`):
- Polls `requests/` every 150 ms, oldest first, with a 64 KB size cap.
- Validates `id`, `caller`, `kind` and `name`, rebuilds each request from its allowed fields, deletes it, and emits `mcp-request`.
- `mcp_reply(id, reply)` writes the reply with `write_atomic`.
- `mcp_status` / `mcp_set_outside_allowed`. The setting is saved like `window.json` and is **off by default**. The 7b chat's own calls (`caller` = the running chat job) are always served; `"outside"` calls only while it is on.

**Frontend `src/lib/mcp/server.ts`** (started from `App.tsx`, like `startBrollPanelBridge`):
- **`list_tools`:** `toolDeclarations(host)` for the connected editor, plus two MCP-only tools:
  - `get_editor_context`: what the in-app chat puts ahead of each message: the editor, the open timeline, the draft, the pool and `editLogContext()`. `snapshotFor` moves out of `controller.ts` into `src/lib/agent/context.ts` so both paths use it.
  - `get_instructions`: `systemInstruction(host)`, for clients that don't get our system prompt (7d).
  - With no editor connected, only `get_editor_context`, which says why.
- **`call_tool` from the 7b chat job:** runs under that turn's `ToolContext` (its step, so the edits join the turn's Revert group), with the same transcript lines and Stop handling as `answerToolCalls` today.
- **`call_tool` from outside (7d):**
  - Builds a fresh `ToolContext` from `useNleStateStore` (the timeline open *now*).
  - Posts each `summary` into the chat transcript as an "Outside (Claude Code)" line.
  - Groups edits into one step, labelled "Outside", starting with the first call after 2 minutes without one. The header's **Revert n edits** undoes an outside run the way it undoes an in-app request.
- **One driver at a time:** while an in-app turn is running, outside edit calls get "VibeCut's own chat is busy; try again when it finishes". While an outside edit runs, the composer waits. Read tools are exempt.

**Python shim `vibecut_agent/mcp_server.py`** (`python -m vibecut_agent mcp`; not in Rust's `COMMANDS`, since the MCP client launches it, not the app):
- Uses the official `mcp` SDK's low-level `Server`, with a dynamic `list_tools` (the app is asked each time) and `call_tool`. `caller` comes from `VIBECUT_MCP_CALLER` (default `"outside"`).
- Converts declarations with the existing `claude_schema.to_claude_tool` (Gemini OpenAPI dialect → JSON Schema), so in-app and MCP schemas can't drift.
- Returns results as JSON text content; an `{error}` result sets `isError`.
- Waits for each reply with a per-tool timeout: 30 s for reads and edits, 15 min for `transcribe_*`, `sync_*` and `run_story_editor`. It sends MCP progress notifications every 10 s while waiting.
- Says plainly when the app isn't running (stale heartbeat) or outside control is off.
- `mcp` is a new **optional extra** (`[project.optional-dependencies] mcp`). `uv.lock` is regenerated in the same change, since every run is `--locked`, but no existing run installs or loads it.

### 7b: "Claude (subscription)" in the chat

**What it is:** a third chat provider, beside Gemini and Claude (API key). The sidecar runs the user's own signed-in Claude Code CLI, so turns use the Claude subscription and need no key.

**How a turn runs:**
- `chat.py` accepts `provider: "claude-code"`. A new `agent/claude_code_chat.py` starts:

  ```text
  claude -p --output-format stream-json --verbose
         --model <claude-opus-5-5|claude-sonnet-5-5> --system-prompt <systemInstruction(host)>
         --tools "" --strict-mcp-config --mcp-config <inline: the 7a shim, VIBECUT_MCP_CALLER=<job id>>
         --allowedTools "mcp__vibecut__*" --permission-prompts none
         --settings '{"disableAllHooks":true}' --max-turns <maxSteps>
         [--resume <session id>]
  ```

  - One `claude -p` per turn, with the user's message on stdin (as built; the plan had one long stream-json process). `--resume` carries the conversation, so nothing is lost, and Stop only has to end one process.
  - `--tools ""` switches off every built-in tool (shell, files, web, skills): checked live, the session's tool list is only `mcp__vibecut__*`.
  - Only VibeCut's MCP tools are allowed, and nothing can stop on a permission prompt.
  - The user's hooks are turned off with `--settings`. `--safe-mode` would do it too, but it also turns off `--mcp-config` servers (checked live), and `--bare` can't use a subscription login.
  - It runs in an empty folder of the app's (`<app data>/claude-code`), so no project's CLAUDE.md or settings apply.
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex switches are removed from its environment, so it can only use the subscription.
- **Events:**
  - Claude Code's stream is translated into the chat protocol the controller already handles: `status` (thinking / calling a tool), `result {text, history, usage}`, `error`.
  - There are no `tool_calls` events for this provider. Its tool calls arrive through the 7a bridge tagged with this job.
- **History:** Claude Code keeps the conversation itself. `result.history` carries `[{ "claudeCodeSession": "<id>" }]`, and the next message resumes it with `--resume`. Switching provider starts over, as today.
- **Stop and limits:**
  - Stop sends SIGINT to Claude Code's process group, then SIGTERM and SIGKILL 5 s apart. The session id is kept, so the next message resumes it.
  - `maxSteps` maps to `--max-turns`.
- **Usage:** read from Claude Code's `result` event into `ChatUsage`.

**Rust:**
- `prepare_request` treats `claude-code` as needing **no key** and strips any `apiKey`.
- **Finding the CLI:** Rust resolves the `claude` program (a Settings path, else PATH and the usual install folders, as `dependency_status` does) and passes its absolute path in the request.
  - On this Mac `claude` is a shell function that sets `CLAUDE_CONFIG_DIR` for a profile, and the sidecar never runs the user's shell.
- **Profile:** Settings gets a **Claude Code profile folder** (`CLAUDE_CONFIG_DIR`). Rust adds it to the environment of this one run only. `passes_to_child` stays unchanged for every other command.
- `ANTHROPIC_API_KEY` is never passed to this run (it already isn't), so Claude Code uses the subscription login and not a key.

**Frontend:**
- `AI_CHOICES` gains "Claude Opus 5.5 (subscription)" and "Claude Sonnet 5.5 (subscription)".
- `availability.ts` reports the provider unavailable when the CLI isn't found or isn't signed in. A Settings **Check** button runs `claude auth status` (or its equivalent) through Rust.
- **About:** a row saying subscription turns go to Anthropic through the user's Claude Code, and count against the plan's usage limits.

**`run_story_editor` stays keyed:** it makes its own model call through `assemble`. On this provider it uses the same Claude model with an Anthropic key if there is one, else Gemini with its key, else it says it needs a key (`storyModel`, storyTools.ts). Rust also refuses `assemble` on `claude-code`. A later follow-up can let Claude write the story script itself through a tool, with VibeCut only checking it and opening the draft.

### 7d: Remote edits through Claude Code's Remote Control

**What it is:** the user starts an interactive Claude Code session on the Mac with VibeCut's MCP server and Remote Control on, then drives it from a phone or another computer (claude.ai or the Claude app). Edits land in the editor through 7a, as "Outside" steps.

**Build work:**
- **Settings → Outside control:**
  - the **Allow** toggle (7a);
  - the last outside request and whether a client is connected;
  - **Copy Claude Code command**: `claude mcp add vibecut -- <uv> run --locked --no-dev --extra mcp --project <root> python -m vibecut_agent mcp`, with this build's absolute paths (dev: the repo; release: the bundled sources).
- **QUICKSTART.md "Remote edits":**
  - turn on Allow, run the copied command once, then start `claude --remote-control vibecut` in a terminal on the Mac;
  - allow `mcp__vibecut__*` when asked (or add it to that profile's allowed tools);
  - the Mac must stay awake, with VibeCut running and the editor connected.
- **The app never edits Claude Code's config itself.** The user runs the copied command.

**What's different when the user isn't watching:**
- Approvals for tool calls appear on the remote device.
- Results come back as tool summaries and `get_editor_context`, with no timeline view.
- Revert works per "Outside" step when the user is back. The "(before VibeCut n)" backups in the editor are the second safety net.

**Not possible:** scheduled cloud agents can't reach the bridge folder on the Mac. A self-built remote inbox (Slack, Telegram, a webhook) would break the no-network-port rule.

### As built (2026-10-06)

**Files:**
- **Rust:** `mcp_bridge.rs` (the bridge, `mcp_reply`, `mcp_status`, `mcp_set_outside_allowed`, `mcp_client_setup`, saved as `mcp.json`), `claude_code.rs` (`claude_code_status`, `claude_code_set`, saved as `claude-code.json`), and `prepare_request` in `sidecar.rs` (now also strips `claudeCode` from anything the UI sends, including later `sidecar_send` lines).
- **Python:** `mcp_server.py` (entry `python -m vibecut_agent mcp`, handled in `__main__.py`, not one of `headless.COMMANDS`), `agent/claude_code_chat.py`, and the `claude-code` provider in `agent/chat.py`. `mcp==2.3.0` is the new `mcp` extra.
- **Frontend:** `lib/mcp/server.ts`, `store/useMcpStore.ts`, `types/mcp.ts`, `lib/agent/context.ts` (`snapshotFor`, moved from `controller.ts`), `runChatTool` in `controller.ts` (one tool call of the running turn, shared by `tool_calls` and bridge calls), Settings → **Claude subscription** (`ClaudeCodeSection`) and → **Outside control** (`OutsideControlSection`), About's Claude Code row, and `storyModel`.

**Details that differ from the plan above:**
- Outside edits are labelled "Claude Code (outside)" in the transcript and the edit log.
- Read tools exempt from the busy lock are `get_editor_context`, `get_instructions` and any `list_`, `get_`, `find_`, `describe_` or `search_` tool.
- The shim's default timeout is 120 s (not 30 s), since an edit first reads the timeline and makes a backup.
- Long tools (15 min): `transcribe_clips`, `sync_and_place`, `sync_clips`, `slip_into_sync`, `run_story_editor`, `send_to_premiere`, `send_to_resolve`, `find_silences`.
- The copied command registers the server at user scope (`claude mcp add --scope user -e … vibecut -- <uv> run --locked --no-dev --project <root> --extra mcp python -u -m vibecut_agent mcp`), with `PYTHONPATH`, `PYTHONDONTWRITEBYTECODE` and, in a release build, `UV_PROJECT_ENVIRONMENT`.

**Tests added:** Rust 14 (`mcp_bridge` 8, `claude_code` 5, `prepare_request` 1), Python 20 (`test_mcp_server.py` 10, `test_claude_code_chat.py` 10; the shim's skip if the `mcp` extra isn't installed), frontend 22 (`server.test.ts` 11, `OutsideControlSection` 3, `ClaudeCodeSection` 5, availability, Story Editor model and controller 1 each). All suites green: pytest 663 (+2 skipped), cargo 103, vitest 358, ruff, mypy, eslint and tsc. Two files ruff would reformat (`nle/links.py` and one other) predate this phase.

**Verified without the editors (2026-10-06, Claude Code 2.1.291, the user's Personal profile, Pro plan):**
- **The shim alone:** `claude -p` with `--mcp-config` and a stand-in app answering through a temp bridge folder. The session's tools were exactly `mcp__vibecut__add_markers` and `mcp__vibecut__list_markers`; Claude called `add_markers` and the stand-in saw it tagged with the caller; `apiKeySource` was `none` (the subscription).
- **The whole 7b chain:** the real `chat` sidecar command on `claude-code` (Sonnet 5.5), started the way Rust starts it, with a stand-in app. Events: `status` "Starting Claude Code…", "Calling Claude…", "Running add_markers…", then `result` with the reply, `[{claudeCodeSession}]` history and usage, in 5.4 s. The stand-in saw `list_tools` and `add_markers`, both tagged `e2e-job`.

**Not yet verified live:** the running app with Premiere or Resolve (the live checks below), Remote Control from a phone, and a long tool against Claude Code's request timeout.

### Tests (all of Phase 7)
- **Rust:**
  - request validation and draining (oldest first; bad files refused and deleted);
  - `mcp_reply` atomicity and the outside-allowed gate;
  - no key and the profile env for `claude-code`, and nothing new in `passes_to_child`.
- **Frontend:**
  - `server.ts`: listing per editor and with none connected; 7b calls joining the turn's step; outside calls grouped every 2 minutes; the busy lock both ways; transcript lines.
  - `context.ts`, with the existing controller tests still passing after the move.
- **Python:**
  - the shim against an in-memory MCP client and a fake app folder: list and call round-trips, schema conversion, stale-heartbeat and "outside off" errors, timeouts and progress;
  - `claude_code_chat.py` against a fake `claude` script that emits recorded stream-json: text, tool use, result and usage, interrupt, resume, and a missing or signed-out CLI.
- **Existing suites** (pytest, cargo, vitest, lint, typecheck) stay green.

### Live checks (with the user's go-ahead, on scratch copies)
- **7b:** in the chat, "Claude Sonnet 5.5 (subscription)" with no API keys set. Read context, add markers, one edit, Revert, Stop mid-turn, and a follow-up message (resume). In Resolve, then Premiere.
- **7d:** `claude --remote-control vibecut` on the Mac, driven from the phone. One marker and one edit, then Revert from the app.
- **Long call:** transcribe, to see whether progress notifications keep the call alive.

### Risks to watch
- **Long tools versus client timeouts.** If progress notifications don't keep a call alive, long tools switch to start + `check_job`.
- **The hidden window's webview** must keep answering bridge requests. It does for the B-roll panel; check that WKWebView doesn't throttle it after hours hidden.
- **Claude Code CLI changes:** its stream-json and flags can change between versions. Pin the tested version in About and fail with a clear message on an unknown event shape.
- **Any local process running as the user** can write to the bridge folder, as with the B-roll panel. Mitigations: outside control off by default, `0700`, strict validation, and only the tools the in-app agent already has.

### 7e: The Story Editor on the subscription, and a first pass for long footage (built 2026-10-06)

**Why (the user, 2026-10-06):**
- **On the subscription:** the Story Editor (`assemble`) should run through Claude Code too, so a story cut needs no key.
- **Long footage:** VibeCut's cap (`MAX_STORY_SEGMENTS`, 2,000 lines) trimmed the **end** of every interview by the same share, so past about 3–4 hours the model never saw the later answers.

**Decisions (the user):**
- **Text only:** transcripts made on the Mac, no audio sent.
- **Claude for both steps by default:** the first pass on **Sonnet**, the story on the chat's model.
- **Option:** a setting to run the first pass on Gemini Flash instead (needs a Gemini key).
- **Only above the cap:** the first pass runs only over 2,000 lines; shorter footage keeps the single call.
- **Not built:** voiceover script writing is a separate feature, left for later.

**How it works:**
- **`agent/claude_code_json.py`, `run_json`:**
  - One `claude -p --output-format json --json-schema <schema>` with `--tools ""`, `--strict-mcp-config` (no MCP server at all), hooks off, `--no-session-persistence`, `--effort` and `--max-turns 4`.
  - The text goes on stdin, and the answer is read from Claude Code's `structured_output`.
  - Stop and a 15-minute timeout end it.
  - Same environment rules as 7b: no `ANTHROPIC_*`, and the chosen profile folder.
- **`story/models.py`:** the calls are general now (`gemini_json`, `claude_json`, `claude_code_json_answer`, each taking any system text, user text and schema). `gemini_story` and `claude_story` are unchanged wrappers, and `claude_code_story` is new. The story keeps effort "high".
- **`story/extract.py`, the first pass:**
  - Above `SINGLE_PASS_LIMIT` (2,000 lines), each interview is split into parts of up to 1,500 lines, read 3 at a time.
  - Each part returns `themes` and `moments` (segment index, why, strength 1–5). Indices only, never quotes, so the story still picks from real lines.
  - The shortlist keeps each moment with one line either side, strongest first, up to 1,800 lines, in the original order.
  - The story call gets those lines, plus "FIRST-PASS NOTES" (themes and each moment's reason) added to the brief.
  - A part that fails fails the cut, Stop stops it, and the result's first warning says what the first pass did.
- **The first pass's model:**
  - `extraction: "same"` uses the story's own provider: Claude Sonnet through Claude Code (subscription), Claude Sonnet through the API (key), or Gemini Flash (key).
  - `extraction: "gemini"` always uses Gemini Flash, with the key Rust adds as `extractionKey` (`set_extraction_key`).
  - It runs at effort "medium".
- **Rust:**
  - `assemble` on `claude-code` gets the Claude Code setup, as the chat does.
  - `extractionKey` is stripped from anything the UI sends.
- **Frontend:**
  - `storyModel` sends the chat's provider and the first-pass choice.
  - Transcripts are capped only at `MAX_STORY_LINES` (20,000) before sending.
  - Settings → Agent model has "Story Editor on long footage: first read" (`storyFirstPass`, saved with the model choice).
  - About lists the Story Editor under Claude Code and the Gemini first-pass option.

**Also fixed:** Claude Code is no longer started in its own process group (7b did that). It stays in the sidecar's group, so the app's cancel and quit reach it, and Stop signals it directly.

**Tests:**
- Python 17 new: `test_claude_code_json.py` 4, `tests/story/test_first_pass.py` 13. They cover parts, shortlist and neighbours, unknown indices, the two-step flow and its notes and warning, Gemini with and without its key, a failed part, Stop, and an empty first pass.
- Rust 1 new: `set_extraction_key`; the subscription test now expects `assemble` to run.
- Frontend: `storyModel`, the request's `extraction`, and the setting's store.
- All green: pytest 680 (+2 skipped), cargo 104, vitest 359, ruff, mypy, eslint and tsc.

**Verified with real Claude Code (2026-10-06, Sonnet 5.5 on the user's Personal profile), no editor:**
- **Short footage:** 12 lines went to one Claude Code call (11.6 s), which made 7 cuts, 25 s against a 30 s target.
- **Long footage:**
  - 2,100 lines of filler with 6 on-brief lines hidden at 300, 301, 950, 1500, 1501 and 2050.
  - The first pass read 2 parts and shortlisted 14 lines, and the story used all 6 (plus one neighbour), 25 s for a 30 s target, in 16.6 s.
  - Line 2050 is one the old 2,000-line cap would have dropped.

**Not yet verified live:** a real multi-hour project in the editors, and the Gemini Flash first pass with a real key.

## Phase 8a: Chats and Revert that survive a restart (built 2026-10-06)

**Why (the user, 2026-10-06):** before this, only the model choice survived a quit. The transcript, the model's history (or Claude Code session) and the edit log were lost, and with them **Revert n edits**. The user chose this as the next build, plus a short list of past chats.

**Storage (one new boundary, `src-tauri/src/chat_store.rs`):** local JSON in the app's data folder (AGENTS.md §4), not localStorage, since a provider's history carries tool results and can run to megabytes.

```text
<app data>/history/          0700; VIBECUT_AGENT_HISTORY_DIR overrides it (tests, parallel dev builds)
  index.json                 [{ id, title, createdAt, updatedAt, messageCount }], newest first
  edit-log.json              { version: 1, entries, backups, restoredIds, nextSeq }
  chats/<id>.json            { version: 1, id, title, createdAt, updatedAt, provider, aiChoice, messages, history, historyDropped? }
```

- **Layout differs from the plan:** the plan put everything in a flat `chats/` folder. The index and the edit log sit one level up, so no chat id can collide with them.
- **Commands:** `chat_list`, `chat_load(id)`, `chat_save(id, chat)` (answers the new list), `chat_delete(id)`, `edit_log_load`, `edit_log_save(log)`. All of them are async, off the main thread.
- **Rules:**
  - ids must match `[A-Za-z0-9_-]{1,64}`, and a chat must carry its own id;
  - every file is at most 16 MB and is written atomically (`broll_panel::write_atomic`), with files `0600`;
  - one save, list or delete at a time (a mutex);
  - only the newest 30 chats are kept;
  - a corrupt chat is left out of the list, a missing or corrupt index is rebuilt from the chats, and a row whose file is gone drops out.
- `storage_paths` gains `history`, shown in About → Storage as "Chats & edit log".

**Frontend:**
- **`lib/agent/chatHistory.ts`** (started from `App.tsx`):
  - The current chat is saved 400 ms after its messages or history change, once it has a user message. When the chat itself changes (New chat, or opening a past one), the old one is saved at once.
  - Saves run one after another. A save already on its way for a deleted chat is dropped.
  - Past 12 MB of history (as JSON), the chat is saved with `history: []` and `historyDropped`, and the transcript says so once.
  - At launch, it reads the list, the edit log, and the chat whose id was open (`chatId` is in the `vibecut-agent.agent` localStorage).
  - The edit log is saved only after the saved one was read, so an empty log can't overwrite it.
  - `pagehide` flushes whatever is waiting.
  - `openChat` and `deleteChat`. A failed save shows under the chat header, and the chat goes on.
- **`useAgentStore`:** `chatId` (a new one on `clear`), and `loadChat`. `newConversation(next?)` in the controller ends the job and shows `next` or nothing. The next message then starts a job with the saved history, as after any ended job.
- **`useEditLogStore`:**
  - `hydrate` puts the saved entries ahead of anything logged since, flagged `fromEarlierRun`.
  - Entry ids never repeat: the next id is above every entry's and above `floorSeq`, which comes from the saved `nextSeq`.
  - The saved copy keeps the newest 500 entries (reverted ones go first), plus the backups of requests still in it.
  - It stays one log for the app, not per chat: Revert follows the timeline, not the conversation.
- **Revert after a restart:** no change in the editors. `revert_timeline_changes` already compares each change with the timeline as it is now (`changedSince`) and falls back to the backup. The header reads **Revert n edits (earlier session)**, and its tooltip says clips changed since are left alone. `editLogContext` tells the agent the edits are from "this session and before the app last restarted".
- **History menu** (`ChatHistoryMenu.tsx`, beside New chat, and **⌘Y** through `useHotkeys`):
  - A listbox of title, relative time and message count, with "Open now" on the current chat.
  - ↑↓ / Home / End move, Enter opens, Delete or the bin icon asks once and deletes on the second press, Escape backs out.
  - Read-only while a turn or an outside (MCP) call runs.
  - A chat whose provider differs from the chosen model gets a note that the model starts without its memory of it.

**Sidecar, a fix that this phase made visible:** resuming a Claude Code session that's gone (cleaned up, another profile) ended at once with a `result` carrying `errors: ["No conversation found with session ID: …"]` and no startup report. Checked live on 2.1.292. 7f's lockdown check read that as "didn't report its tools before starting". Now `claude_code_chat.run_chat_turn` sees it (`session_gone`) and does three things:
- retries once without `--resume`;
- emits `status` "Couldn't resume the earlier Claude Code session; starting a new one…";
- puts `SESSION_GONE_NOTE` ahead of the message, so Claude knows it lacks the earlier context.

The new session id replaces the lost one. Gemini and Claude (API key) need nothing, since their history is resent in full.

**Tests:**
- **Rust 10** (`chat_store`): ids, order, own id, titles, the 30-chat limit, the 16 MB limit, corrupt files and a lost index, delete, the edit-log round trip, modes.
- **Python 2:** the fallback against the fake `claude` (with the 2.1.292 event shape), and `session_gone`.
- **Frontend 32:**
  - `chatHistory.test.ts` 15;
  - `useEditLogStore.test.ts` 6;
  - `ChatHistoryMenu.test.tsx` 7;
  - ChatPanel, hotkeys, `edits` (revert of a hydrated entry, with ids followed) and the agent store, 1 or 2 each.
- **All green:** pytest 692 (+2 skipped), cargo 115, vitest 393, ruff, mypy, eslint, tsc, clippy and `npm run build`.

**Verified with real Claude Code 2.1.292 (Sonnet 5.5), with a stand-in app on a temp bridge folder:**
- A turn with a made-up session id in its history fell back and answered under a new session id: 5.2 s on the Personal profile, and 5.0 s on the **Work** profile (`~/.claude-profiles/Work`, the Blair Academy team plan), which is the login the user uses for VibeCut Agent.
- The bridge saw only `list_tools`, tagged with the job.

**Checked live in Resolve (2026-10-06, project "VibeCut 7a", a scratch copy):**
- **Setup:** "Bakery (VibeCut 1)" (4 video, 4 audio) was copied to "VCA 8a revert after restart". Timeline 28, the one left open, is empty.
- **The edit:** through a real `resolve-watch`, a backup, then one clip switched off and one deleted with its linked sound (changes `enabled`, `deleted`, `deleted`).
- **The quit:** that watcher was ended, and its edit log went through JSON as the saved file does.
- **The relaunch:** a **new** watcher reverted newest first from the saved entries alone (changes, backup, timeline). Everything reverted, with no `changedSince` and no `failed`.
- **Result:** the timeline matched the original clip by clip (track, name, in, out, on/off).
- **What came back differently:** the deleted picture and sound came back under new ids (expected; Resolve gives new items new ids), with the grade, transform and fades taken from the backup (`gradedFromBackup`).
- **Cleanup:** the test timeline and its "(before VibeCut 1)" backup were deleted, nothing was imported, and Timeline 28 is open again.

**Not yet verified live:** the app itself across a quit and relaunch (the chat, the History menu and the header's "(earlier session)" button), and Premiere.

## Phase 8b–8d: Streaming replies, message actions, History upgrades (built 2026-10-06)

**Why (the user, 2026-10-06):** the chat still felt basic. Replies landed all at once after the whole turn, nothing could be copied, retried or edited, and History could only open or delete. The user chose these three, built first, with the live checks after.

### 8b: The reply as it's written

**Sidecar protocol (new events; `chat.py`'s docstring):**
- `reply_delta {text}`: more of the reply.
- `reply_break`: the text so far was said before a tool call. It stays as its own message, and the next delta starts a new one.
- `reply_reset`: the text so far is void (a call retried from the start).
- `result` is unchanged and still the authority: its `text` replaces what was streamed.

**`agent/streaming.py`, `ReplyStream`:** joins deltas and sends them every 40 ms or 200 characters, and always before any other event (`ReplyStream.emit`), so the order holds. All three providers use it.
- **Claude API:** `claude_client.send` gains `on_text` (each `text_delta`) and `on_reset` (before a retry). The chat loop breaks before `tool_calls`.
- **Gemini:**
  - `:streamGenerateContent?alt=sse` (`GEMINI_STREAM_ENDPOINT`) with `requests` `stream=True`.
  - The chunks are gathered into one `generateContent`-shaped answer. Adjacent plain-text parts are joined, and any part with a `thoughtSignature` or `functionCall` is kept exactly as sent. Thought parts aren't streamed.
  - Stop is checked per chunk and closes the stream.
  - A dropped stream, or an `error` chunk with 429/5xx, is retried with a reset. Any other `error` chunk fails the turn, scrubbed.
  - The Story Editor's `gemini_json` stays on `generateContent`.
- **Claude Code:**
  - `--include-partial-messages`; `stream_event` text deltas become `reply_delta`, and a `tool_use` block breaks.
  - `stream_event` joins the "nothing before the lockdown check" guard (Phase 7f).
  - Checked live on 2.1.292: `system/init` comes first, then `stream_event` lines, then the whole `assistant` message.
- **Frontend:**
  - **`controller.ts`:** `liveReplyId` keeps one pending assistant message, then:
    - a break settles it (and removes it if blank), and a reset removes it;
    - `result` writes the final text into it;
    - after Stop, the partial text stays, then "Stopped.";
    - an error or exit leaves it as it stood.
  - **`useAgentStore`:** `appendToMessage`, `removeMessage`.
  - **`MessageList.tsx`:**
    - a caret on the pending reply;
    - its growing text is `aria-hidden` behind a visually hidden "Agent is replying…", and the log is `aria-relevant="additions"`. The finished reply renders under a new key, so it's read once;
    - the list follows new text only while it's within 48 px of the bottom;
    - the activity line hides while a reply streams.
  - **`chatHistory.ts`:** a reply saved mid-stream reopens as `done`.

### 8c: Copy, Retry, Edit

- **Copy:** an icon on user and assistant messages, shown on hover or focus (`navigator.clipboard.writeText`, "Copied" for 1.5 s).
- **The last turn:** `useAgentStore.lastTurn = { userMessageId, history, historyProvider }` is the history exactly as it was sent with the last message (set in `sendUserMessage`). Saved with the chat as `rewind` (`lib/agent/rewind.ts`):

```text
rewind: { userMessageId, historyLength }      Gemini, Claude API (their histories only grow: a slice is exact)
        { userMessageId, session: id | null }  Claude Code (the session the turn forked from)
```

  `lastTurnFrom` checks it against the chat when opened: it must name the last user message, and the history it needs must have been kept.
- **Claude Code can't rewind a session in place.** Checked live: a plain `--resume` keeps the id and adds to it. So every resumed turn now passes **`--fork-session`**. The turn answers under a new id, and the session it started from stays as it was. Live, a retry from the earlier session didn't know a codeword given in the forked turn. Old forks go with Claude Code's own cleanup.
- **`rewindLastTurn()` (`controller.ts`):**
  - **Refused when:** not idle, an outside (MCP) call is running, or later requests made edits (`rewindBlockReason`).
  - **Edits:** if the turn left live edits, it runs `revertLastRequest()` first. If anything changed since or failed, it stops and leaves the conversation as it is.
  - **The take-back:** `takeBackLastTurn` removes that message and everything after it, and puts the history back. The job keeps running, because history goes with every message.
  - **Built on it:** `retryLastTurn()` and `sendEditedMessage(text)`.
- **UI:**
  - **Retry:** under the last turn. With edits it reads "Revert n edits & retry", and while it can't run it's disabled, with the reason as its tooltip.
  - **Edit:** the pencil on the last user message, or **↑** in an empty composer, puts its text in the composer, under a bar: "Editing your last message · Esc to cancel · its n edits are reverted when you send". Clearing the text cancels too. If the send fails, the words go back in the box.

### 8d: History upgrades

**Names:**
- `SavedChat` gains `customTitle?` (the user's) and `autoTitle?` (the model's). The list shows `customTitle`, else `autoTitle`, else the first request. The open chat's names live in `useAgentStore`, so every save keeps them.
- **New `chat_rename(id, title, auto?)` in `chat_store.rs`:**
  - It renames a chat that isn't open: the file and its index row are rewritten, `updatedAt` is unchanged, and so is its place in the list.
  - `auto` sets `autoTitle`, which never replaces a `customTitle`.
  - A blank user name goes back to the model's name, else the first request (`first_request`, as `chatTitle` makes it).
  - Names are one line, at most 60 characters.

**Search:** `chat_search(query)` answers `[{ id, snippet, matchStart, matchEnd }]`, newest first.
- It looks at the name and what the user and the agent said, never tool lines or the model's history.
- Case is ignored per character, so offsets stay in the original's characters ("İ" too). Corrupt chats are skipped.

**Model-written names:**
- **New sidecar command `chat-title`** (`agent/titles.py`; the allow-list, `needs_llm_key` and Claude Code injection in `sidecar.rs`). It makes one schema call through `story/models.py`'s helpers on the chat's own provider and model, at low effort. It sends the first request (without the snapshot) and the first answer, each cut to 2,000 characters. `clean_title` keeps one line of at most 60 characters, with no quotes or full stop.
- **`lib/agent/chatTitles.ts`** (started from `App.tsx`) asks once per chat, as a turn ends (never just for opening one), when the chat has a finished answer and no name. The answer goes to the store if the chat is open, else through `chat_rename(…, auto)`. A failed job changes nothing.
- **Settings → Chat → "Name chats with the model":** on by default and remembered.
- **Checked live** (Claude Code, Work profile): "Red markers on Bakery interviews".

**The History menu (`ChatHistoryMenu.tsx`):**
- A search box takes focus when it opens. Names filter as you type, and messages are searched 150 ms after typing stops, with the match marked in a snippet. "No chats match" when none do.
- From the box: ↑↓ Home End move, Enter opens, **F2** renames inline (Enter saves, Escape leaves), and Escape clears the search, then closes. Delete twice still works from the list (Tab).
- A pencil sits beside the bin. Renaming works during a request; opening and deleting don't.

**Disclosure:** About's Gemini line now mentions naming chats. No new hosts.

### Tests
- **Python (+26):**
  - `ReplyStream` 5;
  - Gemini streaming 6: gathering, signatures and calls kept, thought parts, a reset on retry, an error chunk, Stop mid-stream;
  - Claude streaming and break 2;
  - Claude Code streaming, the guard, `--fork-session` 2;
  - `titles.py` 11.
  - The Gemini and session fakes now answer as SSE.
- **Rust (+4):**
  - `chat_rename`: place kept, and user over model over first request;
  - `chat_search`: what's said, never history; length-changing case;
  - `chat-title` injection asserts in the `prepare_request` tests.
- **Frontend (+36):**
  - controller streaming 5 and Retry/Edit 8;
  - `rewind.ts` 3;
  - MessageList 5;
  - Composer edit 3;
  - `chatHistory` 5;
  - `chatTitles.ts` 4;
  - History menu search and rename 3.
- **All green:** pytest 718 (+2 skipped), cargo 119, vitest 429, ruff, mypy, eslint, tsc, clippy `-D warnings`, `npm run build`.

**Checked with real Claude Code 2.1.292 (Sonnet 5.5, the Work profile), with the real MCP shim and no app running (its fallback `get_editor_context` answers):**
- The lockdown check passes with partial messages.
- Deltas came before the result, and the tool call ran.
- Each turn forked.
- A retry from the earlier session didn't know a codeword given after it.
- `chat-title` answered.

**Checked live with the API keys (2026-10-06), `run_chat_turn` direct, a stand-in `count_markers` tool answering `{markers: 4}`:**
- **Gemini** (`gemini-flash-latest`):
  - The first delta came after 2.0–2.5 s.
  - "I will check the number of markers…" streamed, then `reply_break` before `tool_calls`, then the answer.
  - The streamed text matched `result.text`.
  - The next turn, sent the gathered history (thought signatures included), was accepted.
- **Claude API** (Sonnet 5.5):
  - The first delta came after 1.1 s, with the same order: text, break, tool call, answer.
  - The streamed text matched `result.text`.
  - The next turn (thinking blocks and tool use in history) was accepted.

**Not yet verified live:**
- The app itself: a streamed reply on screen, and Copy in the Tauri webview. If `navigator.clipboard` is refused there, add `tauri-plugin-clipboard-manager` with only `allow-write-text`.
- Retry and Edit, and "Revert & retry" on a scratch Resolve timeline.
- Search, rename and a model name across a relaunch.

## Phase 8e–8h: Formatted replies, tool cards, images, saved prompts (built 2026-10-06)

**Why (the user, 2026-10-06):** after 8a–8d the chat still showed replies as plain text and each tool call as one line, took words only, and had nothing reusable. The user chose all four.

### 8e: Formatted replies and timeline positions
- **New deps:** `react-markdown` 10 and `remark-gfm` 4. Raw HTML stays text (react-markdown's default), so there's no sanitizer.
- **`components/chat/Markdown.tsx`:** renders a finished assistant reply: lists, emphasis, code (a fenced block has its own Copy), and GFM tables (scroll sideways). The streaming reply stays plain text until it's done (8b's new key). User, tool, system and error messages stay plain.
- **Links (`safeUrl`):**
  - `http(s)` opens in the browser (`openExternal`, `@tauri-apps/plugin-opener`'s `openUrl`; `opener:default` allows it);
  - `t:<seconds>` is a timeline position;
  - anything else (`javascript:`, `file:`) renders as text;
  - a Markdown image shows as its alt text.
- **Timeline positions:**
  - The prompt asks the agent to write them as `[1:23.4](t:83.4)` (seconds from the timeline's start, the snapshot's convention).
  - SMPTE timecodes in text or inline code (`01:00:12:10`, drop-frame `;`) become the same chip (`remarkTimecodes`). They're placed with `lib/agent/timecode.ts` (29.97/59.94 drop-frame counted), using the fps and start timecode of the last snapshot. `snapshotFor` stores these as `useNleStateStore.lastTimeline`: null for a draft or no timeline, and then timecodes stay text.
  - **The chip (`TimecodeChip`):** `nleCall(host, "set_playhead", { timeline, time })` on the editor's open timeline. It's disabled, saying why, with no editor or no timeline, and shows a failure for 2 s.

### 8f: Tool call cards
- `ChatMessage.tool?: { name, args, result?, state: "running" | "done" | "failed" }`. `args` and `result` are pretty JSON cut to `TOOL_DETAIL_CHARS` (4,000) by `toolDetail`, and the message's `text` is the summary.
- **`runChatTool`** adds the card as running, then sets its summary and result. A result with `error` counts as failed. A call refused after Stop makes no card. All three providers go through it: Claude Code's calls come in over the MCP bridge.
- **`ToolCards.tsx`:** consecutive cards group. A group stays open while its turn runs (`MessageList`'s `busy`), then folds to "n tool calls · m failed". Each card opens to show Arguments and Result, each with Copy. Retry notes, revert summaries and the step-budget note stay plain lines.
- **Saved chats:** a malformed `tool` is dropped, keeping the line, and one saved while `running` reopens as `done`.

### 8g: Images with a message
**Limits** (`lib/agent/attachments.ts`, `agent/attachments.py`, `chat_store.rs`):
- 4 images per message;
- PNG/JPEG/WebP/GIF;
- at most 1568 px on the long edge;
- at most 3.75 MB each (4 MB on disk).

**Shrinking (`prepareImage`):** an image within the edge limit and under 1 MB goes as it is. Otherwise it's redrawn in a canvas: a PNG stays PNG if that comes out under 1 MB, else it becomes JPEG at 0.85 (0.7 if still too big) on white.

**Composer:**
- **Ways in:** the image button (a file picker), a paste, or a drop anywhere on the chat. `dragDropEnabled: false` on the window lets HTML drops reach the page; the native drag *out* of the Library is unaffected.
- **Chips:** thumbnails with a remove button. Backspace in an empty box removes the last one.
- **Sending:** images can go without words, and the message reads "(image)". A send that didn't go out puts the words and images back.

**Storage (new commands, `chat_store.rs`):**
```text
<app data>/history/attachments/<chatId>/<attId>.<png|jpg|webp|gif>   0700 folders, 0600 files
chat_attachment_save(chatId, attachmentId, mime, data: base64)        ids as chat ids; type allow-list; ≤ 4 MB
chat_attachment_load(chatId, attachmentId) → { mime, data }
```
- Deleting a chat, or its falling off the 30-chat list, removes its folder.
- Messages keep only `attachments: [{ id, name, mime, width, height, bytes }]`, so chat files stay small. Thumbnails load on demand (a 40-image cache). One that's gone says "no longer on disk".
- Images left behind when an edit drops them stay until the chat is deleted.

**Sending:**
- **Order:** `sendUserMessage(text, images)` files the images first (a failure stops the send, says so, and returns false), then adds the message.
- **Payload:** `attachments: [{ mime, data }]` goes on the first `chat` request and on `user_message`.
- **Retry and Edit:** Retry reads the images back before taking the turn back. Edit puts them back as chips.

**Sidecar protocol (`chat.py`):**
- The request and `user_message` gain an optional `attachments`, checked by `parse_images`: a list of at most 4, of the allowed types, valid non-empty base64, at most 3.75 MB each. A bad one is a `RequestError` before any model call.
- Each provider's `run_chat_turn` takes `images`:
  - **Gemini:** `inline_data` parts ahead of the text;
  - **Claude API:** `image` blocks ahead of the text;
  - **Claude Code:** see below.
- **History:** the images stay in API providers' history, so later turns still see them (checked live). The existing 12 MB guard still drops an oversized history.

**Claude Code now always runs with `--input-format stream-json`:**
- The turn is one user line of image and text blocks (`user_line`). The lost-session note is its own leading text block.
- **Checked live on 2.1.292 (Work profile):** the image was read, `system/init` still comes first, with no echo of the user line. `--resume` + `--fork-session` answers under a new id and remembers the image. A gone session still ends with the same `errors: ["No conversation found…"]` result, so `session_gone` holds.

**Disclosure:** About's three provider lines say attached images are sent to the chosen model. There are no new hosts.

### 8h: Saved prompts
- **`store/usePromptStore.ts`:**
  - **Storage:** localStorage `vibecut-agent.prompts`, version 1. Malformed entries are dropped on load.
  - **Names:** `[a-z0-9][a-z0-9-]{0,31}`, unique. Bodies are at most 4,000 characters.
  - **Starters:** `/markers-from-transcript`, `/find-silences`, `/rough-cut`, `/broll-ideas` and `/summarize-timeline`. "Restore starters" puts back missing ones by name and never overwrites.
- **Composer:** `/` then a name, alone in the box, opens a listbox: names starting with the query first, then names containing it.
  - ↑↓ choose (`aria-activedescendant` on the box), Enter or Tab puts the body in the box (it never sends), and Esc closes the list for that text.
  - A `{{…}}` in the body is selected, ready to type over.
- **Settings → Saved prompts (`PromptsSection.tsx`):**
  - New and Edit, inline, with name and message problems shown;
  - Delete on the second press;
  - Restore starters;
  - Esc leaves a form. `Modal` now ignores an Escape something inside already used (`defaultPrevented`).

### Tests
- **Python (+10):** images through Gemini and Claude, six refusals, the size limit, and Claude Code's stream-json line (image blocks; the session-gone note as a block). The two plain-stdin checks were updated.
- **Rust (+2, and the modes test):** attachments round trip, ids/type/base64/size refused, they go with a deleted or pruned chat, `0700`/`0600`.
- **Frontend (+42):**
  - `timecode` 5 and `Markdown` 7;
  - controller cards 2 and images 4;
  - `ToolCards` 3;
  - `attachments` 3;
  - Composer images 4 and prompts 3;
  - sent images 1;
  - `chatHistory` 2;
  - prompt store 5 and `PromptsSection` 3.
- **All green:** pytest 728 (+2 skipped), cargo 121, vitest 471, ruff, mypy, eslint, tsc, clippy `-D warnings`, `npm run build`.

**Checked live (2026-10-06):**
- **Gemini** (`gemini-flash-latest`) and the **Claude API** (Sonnet 5.5), via `run_chat_turn` with a 32 px PNG: each said its colour ("Green"), and a follow-up sent only the history answered "Green" too.
- **Claude Code** 2.1.292 (Work profile, the real MCP shim, no app): "Blue." The lockdown check passed, the reply streamed, and the next turn forked to a new session and still answered "Blue."

**Not yet verified live (in the app):**
- Markdown and a chip moving the playhead (Resolve, scratch timeline);
- cards during a real request;
- paste, pick and drop (drop needs `dragDropEnabled: false` in a real window);
- thumbnails after a relaunch;
- `/` in the composer.

## Phase 9: Effort, a usage tracker, the Mini Player (built 2026-10-07)

The user's choices: an effort picker per Claude model, medium by default; a usage tracker with the plan's limits **and** tokens and cost; and a Mini Player that is the same window shrunk to a bar, with no menu-bar text.

### 9a: Effort per model
- **Settings → Agent model:** "Opus effort" and "Sonnet effort" (Low, Medium (default), High, Extra high, Max). They're kept in `useAgentStore.effort`, persisted as `{opus, sonnet}`.
- **The flow:** `controller.ts` puts `effort` in the `chat` start request for a Claude choice (API or subscription), never for Gemini. The effort is part of the session key (`<choice>:<effort>:<host>`), so a change starts a new job and the history carries over.
- **Python:**
  - `claude_client.EFFORT_LEVELS` and `resolve_effort(effort, model)`: an unknown level falls back to the default.
  - `EFFORT` is now medium for both models. Opus was `high` before.
  - `claude_chat` sends it as `output_config.effort`.
  - `claude_code_chat.build_args` always passes `--effort`, so the Claude Code profile's own default no longer applies.
- The Story Editor and the chat-title calls keep their own fixed levels.

### 9b: The usage tracker
- **Plan limits from the chat:** in `stream-json`, Claude Code 2.1.292 emits `{"type":"rate_limit_event","rate_limit_info":{status, resetsAt, rateLimitType, utilization, unifiedWindows:{five_hour:{utilization,resetsAt}, seven_day:{…}}}}`. `utilization` is a fraction and `resetsAt` is in epoch seconds.
  - `claude_code_chat.plan_limits()` turns it into `PlanLimits`: `{status, limiting?, fiveHour?, weekly?, weeklyOverage?}`, each window `{used, resetsAt?}`. It's sent as a new chat event, `rate_limit {limits}`.
  - `unifiedWindows` is marked internal in the CLI, so the top-level `utilization` stands in for the limiting window when it's missing.
- **Cost of a subscription turn:** the turn's `usage` gains `costUsd`, from the result's `total_cost_usd`: what the turn would have cost on the API. The plan pays for it.
- **Plan limits on demand:** the new Rust command `claude_code_usage` (`claude_code.rs`) runs `claude -p "/usage" --output-format json --no-session-persistence --settings '{"disableAllHooks":true}'`.
  - It uses the saved profile, a bare environment, the app's empty work folder and a 20 s timeout.
  - `/usage` is answered locally, with no model call (0.7 s live).
  - `usage.parsePlanUsage` reads "Current session: N% used · resets …" and "Current week (all models): …". Single-model weekly lines are left out.
  - `lib/agent/planRefresh.ts` asks when the window gains focus and the last report is over 15 minutes old, and from the popover's Refresh. It only asks when Claude Code is usable.
- **Tokens and cost:**
  - `useUsageStore` (localStorage `vibecut-agent.usage`) keeps `plan`/`planAt`, `days[YYYY-MM-DD][choiceId]`, and `chats[chatId]` (30 days, 200 chats; a deleted chat is forgotten).
  - `lib/agent/usage.ts` prices API turns at Opus 5.5 $4/$20 and Sonnet 5.5 $2/$10 per MTok, with cached input at $0.20 and cache writes at the input rate.
  - Subscription turns show Claude Code's figure as "≈", covered by the plan.
  - Gemini (`gemini-flash-latest`, an alias whose price moves) shows tokens only.
- **UI:** `components/usage/UsageMeter.tsx`.
  - A header pill shows the 5-hour bar and %, amber at 75% and red at 90% or when `rejected`. Without a plan report it shows today's tokens.
  - Clicking it opens a popover: both windows with "Resets in …", Refresh, this chat, then today and the last 7 days per model.
  - The Mini Player has a compact version.

### 9c: The Mini Player
- **`mini_player.rs`:**
  - `set_mini_player(on)` / `mini_player_status`, and the `mini-player` event.
  - **Going mini:** remembers the full frame in memory. The window goes undecorated, not resizable, 380×112, floating over full-screen apps (`window_mode::apply(true)`), at the saved `miniPosition` or the top-right of the screen.
  - **Expanding:** puts the frame, decorations and limits back and re-applies the saved Keep on Top.
  - `WindowEvent::Moved` tracks the bar. Its place is saved to `window.json` (`miniPosition`) on expand or quit.
  - *(2026-10-22)* A saved `miniPosition` whose bar centre is on no connected screen (its monitor unplugged) is ignored, and the bar goes to the top-right (`on_a_screen`, +1 Rust test). Before, the bar opened off-screen and looked like it had vanished.
  - `window_mode::save_field` now merges into `window.json` instead of overwriting it. Keep on Top changes made while mini apply on expand.
- **Tray:** a "Mini Player" check item (⌥⌘M). Every "open" item expands first.
- **Capability:** `core:window:allow-start-dragging`, for `data-tauri-drag-region`.
- **Frontend:**
  - `useUiStore.miniPlayer` and `hooks/useMiniPlayer.ts` (`toggleMiniPlayer`, which closes overlays on the way in).
  - `App.tsx` renders `components/mini/MiniPlayer.tsx` in place of the shell.
  - **The bar:** the editor and timeline, the usage pill, Expand, then the current activity or the last answer as one plain line, then a one-line box sharing the chat's draft and images, with Send or Stop.
  - **Keys:** Return sends and Escape clears. A double-click on the bar expands.
  - **Hotkeys:** ⌥⌘M toggles (matched by `code`, since ⌥M types µ). ⌘1/⌘2/⌘,/⌘I/⌘Y expand first.
  - The header has a Mini Player button.

### Tests
- **Python (+7):** `--effort` default and override, `plan_limits` from the live event shape and its fallback and junk handling, the `rate_limit` event, `costUsd`, effort on the Claude API, and `chat.py` passing effort to Claude and not to Gemini.
- **Rust (+3):** `parse_usage`, the mini position parse, and the first-bar placement. The tray test now covers the Mini Player item.
- **Frontend (+32):** `usage` 9, `useUsageStore` 4, `UsageMeter` 4, `MiniPlayer` 7, `useMiniPlayer` and the hotkey 4, the controller's effort, Gemini and usage 3, and the agent store's effort 1.
- **All green:** pytest 735 (+2 skipped), cargo 124, vitest 503, ruff, mypy, eslint, tsc, clippy, `npm run build`.

### Checked live (2026-10-07, Claude Code 2.1.292, Work profile)
- `claude -p "/usage" --output-format json`: the report text above, in 0.7 s, with no model call. Its exact text is the parser's fixture.
- A Haiku turn in `stream-json`: the `rate_limit_event` line above, and `--effort medium` was accepted.
- `claude_code_chat.run_chat_turn` with the real MCP shim and no app, Sonnet at `effort="low"`: "Ok". It emitted `rate_limit {fiveHour: 0%, weekly: 3%}` and `usage.costUsd` 0.0082.
- **Not checked:**
  - The Claude API at medium: the repo `.env` key returns 401 now; the app uses the Keychain's.
  - The Mini Player and the usage pill in a real window. Your own `tauri dev` was running and wasn't touched.

## Phase 10: A fuller B-Roll Analyzer (built 2026-10-07)

**Why (the user):** make the Folder tab (Phase 4's analyzer, now the **Analyze** tab) sturdier and match VibeCut's own B-Roll Analyzer app (`VibeCut/src-python/broll-analyzer/app.py`): parameter controls that are remembered, several segments per clip, a way to preview a segment, and XML creation. **Decisions:** the preview plays **in the app**; the selects go to a **Premiere XML** and to **a new timeline in the connected editor** (VibeCut's FCPXML for Resolve was not ported: its own notes record that Resolve's import fails to relink). The header ("top bar") layout was left for later.

The engine already supported all of this (ported in Phase 4, unused by the UI): window length, segments per clip, weights, workers, top N / minimum score, order, and `xml_export.export_xml`.

**Options** (`AnalyzerOptions.tsx`, `useBrollStore`):
- Shown: segment length (0.5–120 s), segments per clip (1–20), gap between segments (0–30 s, new `minGapSec`, passed through `pipeline.run_analysis` to `analyze_clip` / `rescore_clip`).
- Advanced (folded): energy and brief weights (content-aware only), workers (automatic by default), Reset to defaults.
- Typing is free; a value is clamped to `commands.py`'s ranges on Enter or blur (`cleanOptions`).
- Remembered in localStorage (`vibecut-agent.broll`, now **version 2**). A Phase 4 save migrates with every option at its default; bad saved values are cleaned.

**Results:**
- The last finished run is kept (`lastResult`, at most 500 clips) with the options it used, so a restart still shows it. A cancelled run isn't kept.
- When a scoring option differs from the kept run's, a bar names it and offers **Re-score**. Cached clips aren't decoded again (`rescore_clip`). Weights that weren't in use don't count.
- Warnings and failed clips fold under "n issues".

**Segments:** each clip row lists its segments as chips (`▶ 0:04–0:08 · 82`). A chip's box ticks it in or out of the selects (`excluded`, saved; reset by a new run); clicking it previews it. **Place** puts in the segment being previewed, else the best one.

**Preview** (`SegmentPreview.tsx`):
- A `<video>` pinned above the list, from `convertFileSrc(path)`, after `broll_preview_allow` (new `broll_preview.rs`). The CSP gains `media-src 'self' asset: http://asset.localhost`.
- It loops between In and Out, starts muted (sound toggle), with Replay, previous/next segment and **Open in Source monitor** (`openInSourceMonitor`, now shared with the Library's `previewShot`).
- Keys: Space, ←/→, R, Esc.
- `.mov`, `.mp4` and `.m4v` play here; other formats, or a codec the web view can't decode, show the Source monitor offer instead.

**Selects** (`SelectsBar.tsx`, `lib/brollSelects.ts`):
- Include every clip, the best N, or those scoring at least a minimum; order best first or by file name; a sequence name. Clips left out are dimmed. Near-duplicates (dedupe runs) are always left out, as the analyzer's own export does.
- A summary line: segments, clips, length.
- **Export XML…:** the save dialog, then the new sidecar command **`broll-export`** (`commands.run_export`). It reads each clip's metadata from `.broll_analyzer_cache.json` (no decoding), takes the chosen segments, score and energy from the request, and calls `export_xml` with the sequence name. Paths must be inside the folder and analyzed; segments must be inside the clip; the output must be an absolute `.xml` path. The result offers Show in Finder.
- **Build timeline** (`buildSelectsTimeline` in `lib/broll.ts`): `create_timeline` with the sequence name (recorded in `madeTimelines`), then `add_clips` with the segments back to back from 0, picture and sound, in batches of 50 (Premiere's limit). Every batch shares one step, so the Agent tab's **Revert** takes the clips back as one request; the new timeline itself stays, as with the agent's `create_timeline`. It's refused while a Story Editor draft is open or with no editor connected (the button says why).

**Tests:**
- Python `tests/broll/test_commands_export.py` (13): `minGapSec` reaches the analyzer; the XML has one clipitem per chosen segment in order, with the right frames; no decoding; bad requests refused.
- Rust `broll_preview::tests`.
- Vitest: `brollSelects.test.ts` (6), `useBrollStore.test.ts` (8), `broll.test.ts` (+6: options sent, kept run, XML export, a 60-segment build in two batches as one step, refusals), `FolderAnalyzer.test.tsx` (+8: options, kept result, ticks, Include, stale bar, preview, format fallback, export).

**Tabs (the user, 2026-10-07):** the Library moved up into the main tab bar and B-Roll became Analyze, so the window has one row of tabs: **Agent ⌘1 · Library ⌘2 · Analyze ⌘3**. The Library/Folder sub-bar (`BrollPanel.tsx`) is gone, along with `useLibraryStore.view`. A new `View::Library` (`state.rs`) and a tray item **Open B-Roll Library** (`tray.rs`) open it; "Open B-Roll Analyzer" still sends `broll`, which is the Analyze tab. Each tab's tooltip says what it does. ⌘2 used to open B-Roll; it now opens the Library.

**Checked live (2026-10-07), with the real sidecar on clips made with ffmpeg** (a 24 s clip blurred at 6–12 s and 16–20 s, a 12 s clip sharp only after 8 s, a 10 s mandelbrot zoom):
- `broll-analyze` with 3 s segments, 3 per clip, 1 s gap: the blurred clip gave 1.4–4.8, 13.0–16.3 and 20.6–24.0 s, missing both blurred spans; the mostly blurred one gave only 8.6–12.0 s.
- `broll-export` with one segment unticked, in 0.3 s: "VCA 10 selects", 4 video items back to back (336 frames), audio split per channel (mono 1 track, stereo 2, the silent clip none).
- **Not yet:** the Analyze tab in the running app (the player on real footage, Export XML's save dialog), Build timeline in Resolve on a scratch copy, and importing the XML in Premiere.

**About:** a new "B-roll analyzer · Local only" row. Nothing new is sent anywhere.

## Phase 11: Settings tabs, a queue, @-mentions, review before edits, notifications, faster first token (built 2026-10-07)

**The user's picks:** the four chat features (a queue while the agent works, @-mentions, Review edits first, done notifications) and, of the optimizations, a faster first token. Asked mid-phase: Settings split into tabs, with anything About already shows taken out.

### 11a: Settings in tabs
- `SettingsPanel.tsx` is now a tab strip (ARIA tablist, ←/→/Home/End). The last tab is kept in `useUiStore.settingsTab` for the app's run.
  - **General:** Window, Notifications.
  - **Agent:** Agent model (model, effort, Story Editor first read), Chat (Review edits first, names), Saved prompts.
  - **Accounts:** API keys, Claude subscription.
  - **Editors:** Preferred editor, Connections (Reconnect, Premiere panel), Outside control.
  - **Library:** the Spyglass index.
- Each section is its own file: `AgentModelSection`, `ChatSection`, `WindowSection`, `PreferredEditorSection`, `NotificationsSection`.
- `Modal` gains `toolbar` and `fill`, so the tabs sit outside the scroll and the dialog doesn't jump between tabs.
- **Removed as About's:** the Agent sidecar section (Restart is now the ↻ on About's sidecar row, `SidecarStatusRow`), Local dependencies (Refresh is now on About's Binaries heading), and each editor's connection detail line (Settings keeps the dot and Reconnect). `KEY_ENV` for About comes from `types/agent`.
- Section titles are unchanged, so the app's "Settings → Claude subscription"-style hints still name a section. QUICKSTART now gives the tab too.

### 11b: Queue while working
- **`useAgentStore`:** `queue` (`QueuedMessage {id, text, images, mentions}`, at most `MAX_QUEUE` = 5, not persisted) and `queuePaused`.
- **`controller.ts`:**
  - `submitMessage` sends now, or queues while a turn runs, Claude Code edits from outside, or messages already wait.
  - `drainQueue` runs after each turn's `endTurn` (a `setTimeout 0`, once the result is handled) and when `outsideRunning` drops to 0.
  - A Stop, an `error`, or the job's exit hold the queue (`pauseQueue`).
  - `resumeQueue` is Send next. `editQueued` takes one back into an empty box.
  - New chat and opening a chat clear it.
- **UI:**
  - `QueueList.tsx` above the composer: Edit, Remove, and when held, "Send next · Clear".
  - While busy, the composer shows Queue (ListPlus) beside Stop, and Enter queues.
  - The Mini Player queues on Return and says "n queued".

### 11c: @-mentions
- **`lib/agent/mentions.ts`:**
  - `mentionQuery` (the `@word` before the caret).
  - `allMentions` reads timelines, plus clips and markers from the timeline the last snapshot read. `context.ts` keeps it (`lastTimelineView` / `rememberTimelineView`), else `loadMentionTimeline` reads it once when the list opens, or uses the open draft. It also reads the pool (`p3` ids), the speakers named this connection, and the Library's results and pool. No new search runs.
  - `matchingMentions` gives up to 8 per group, with names starting with the typed text first.
  - `keptMentions` keeps only the `@label`s still in the text.
  - `mentionBlock` writes the block.
- **What the model gets:** after the snapshot, `[MENTIONED: what the user pointed at with @ in this message]` with one line each (`- @Interview A.mov = clip id "c1" (V1 0.0s–12.5s)`). `prompt.ts` has one line explaining it.
- **Saved and carried:** `ChatMessage.mentions` is saved (checked in `parseSavedChat`) and carried by Retry, Edit and the queue.
- **UI:**
  - The "/" list became the shared `SuggestionList.tsx`, with group headings, used for both lists.
  - User messages show mentions as chips (`MentionText.tsx`, a tooltip with the id).

### 11d: Review edits first
- **`toolKinds.ts`:**
  - `CHANGING_TOOLS` (30) and `NOT_REVIEWED` (24). A test fails if any tool `executorsFor`/`toolDeclarations` gives (both editors) is in neither, so a new tool must be classified.
  - **Reviewed:** edits, markers, timeline make/copy/switch/rename, import, link/unlink/sync, speaker roles, `send_to_*`, `discard_draft`.
  - **Not reviewed:** reads and searches, the selection, the playhead, transcribing, the Story Editor (it only opens a draft), and the draft's own cuts, which reach the editor only through `send_to_*`.
  - `describeChange` writes the card's line ("Delete 3 clips: A.mov, B.mov, C.mov"), with clip names from the last read timeline.
  - `server.ts`'s `isReadTool` is unchanged on purpose: it decides what an outside client may run while the chat works, a different question.
- **The setting:** `useAgentStore.reviewEdits` (persisted, off by default). It's in Settings → Agent → Chat and on the shield in the Agent tab's top row.
- **`runChatTool`:**
  - A change gets a `pending` card (`ChatToolCall.state` gains `pending` and `declined`) and waits on `review.ts` (`awaitReview` / `answerReview`).
  - The card offers Apply, Skip, and Apply all for this request, which approves that step's later changes.
  - Skip returns `{declined: true, error: DECLINED_ERROR}` to the model.
  - Stop and the job ending skip whatever waits (`skipAllReviews`).
  - A `pending` card in a saved chat loads as `declined`.
- **Claude (subscription):**
  - The shim gave up on a call after 120 s. `runChatTool` now calls `onWait`. The MCP server's `handleRequest` passes `mcpHold(request.id)`, and the new Rust command **`mcp_hold`** writes `replies/<id>.hold`.
  - `AppBridge.ask` then allows `HOLD_TIMEOUT_SECONDS` (30 min) and deletes the hold with the reply.
  - `claude_code_chat.child_env` sets `MCP_TOOL_TIMEOUT=1800000`.
  - Stale holds are pruned with the replies (30 min).
- Outside control (remote sessions) isn't reviewed; those sessions aren't the in-app chat.

### 11e: Done notifications
- **Plugin:** `tauri-plugin-notification` 2 and `@tauri-apps/plugin-notification`, with the capability `notification:default`.
- **`lib/notify.ts`:**
  - `notifyAway(title, body)` checks `getCurrentWindow().isVisible()` / `isFocused()` (default window permissions) and only notifies when the window is hidden or another app is in front.
  - The body is the first line, Markdown stripped, at most 120 characters.
  - Never throws.
- **`useNotifyStore` (persisted):** `enabled` (on) and `sound` (off; macOS "Glass").
- **Settings → General → Notifications:** turning it on asks macOS once (`enableNotifications`). A refusal points to System Settings.
- **When:**
  - a turn finishes with nothing left in the queue (not after a Stop);
  - an `error`;
  - a change waits for review.
- **About:** a "Notifications · Local only" row.

### 11f: Faster first token
**Measured before (2026-10-07, this Mac, Claude Code 2.1.292, Work profile):**
- **A chat job's imports:**
  - Release env (`python-env`, 0 `.pyc`): 1.2–1.65 s.
  - Dev `.venv`: 0.7–0.9 s.
  - `anthropic` alone: 0.6 s, imported on the Claude Code path for `resolve_effort` only.
- **Claude Code:**
  - A cold turn reports `system/init` 1.3–2.3 s after it starts.
  - Probe: it starts and connects its MCP server (the shim's `list_tools` arrives at 1.1 s) **before** reading its message. Its `init` then comes 0.05 s after the message is written.

**Changes:**
1. **Bytecode:**
   - A release run sets `PYTHONPYCACHEPREFIX=<app data>/pycache` (`sidecar::bytecode_env`, also the MCP shim's launch) in place of `PYTHONDONTWRITEBYTECODE`. Every `.pyc`, for the packages and the bundle's sources, lives there; the signed bundle is never written.
   - Dev runs and ResolvePython are unchanged.
   - (`UV_COMPILE_BYTECODE` was tried and dropped: uv then re-checks bytecode on every run, +0.45 s.)
2. **Lighter imports:**
   - `agent/effort.py` holds the effort levels.
   - `ChatError` and `STOPPED_NOTICE` live in `chat_steps.py`; `gemini_chat` imports them back.
   - `headless.py` imports the chat and the watchers per command.
   - The Claude Code path now loads none of `anthropic`, `requests` or `nle.watch` (tested in a subprocess).
3. **Connections reused:** `claude_client._make_client` is cached per key (`lru_cache`), and Gemini uses one `requests.Session` (`gemini_chat._http_post`).
4. **The first words go at once:** `ReplyStream` no longer holds them for 40 ms.
5. **Snapshot:** the pool and the timeline are read side by side, and images are filed alongside.
6. **Warm job:** the first keystroke in an empty composer (agent idle, no job) starts the chat job with no `userMessage` (`warmUp`). `chat.py` (`_converse`) waits for the first `user_message`. A send waits for a start in progress (`warming`).
7. **Warm Claude Code:**
   - `claude_code_chat.Launcher` keeps the next turn's `claude -p` started, with stdin open. `chat.py` calls `prepare_turn` after each turn and at a warm start.
   - A turn with the very same arguments takes it. Any other turn (a Retry or Edit resuming an earlier session, the lost-session fallback) ends it and starts its own.
   - `close()` ends it with the job.
   - No model call happens until a message is written.
8. **Timing:** `lib/agent/turnTiming.ts` marks send → timeline read → sent (new or running job) → first status → first words. It logs `[VibeCut] turn timing: …` to the console, and the status bar's Ready/Working tooltip shows the last one.

**Measured after:**
- **Imports with the prefix cache**, against the untouched release env:
  - Claude Code path 0.11 s (was 1.2–1.65).
  - Claude API path 0.68 s (was 1.15).
  - The first run after an install or update pays the compile once (0.35 s / 1.9 s).
- **`claude_code_chat.run_chat_turn` with real Claude Code** (Sonnet 5.5, low effort, a stand-in app on the bridge):
  - **Cold:** init 1.27–1.46 s, first words 2.3–5.6 s.
  - **Warm:** init 0.03–0.05 s, first words 1.1 s.
- Gemini and the Claude API weren't timed end to end. The repo `.env` Anthropic key still returns 401.

### Tests
- **Python (+9):**
  - Warm start: waits for the first message.
  - The job's launcher: prepared at start and after a turn, closed with the job.
  - The subscription path's imports.
  - Launcher: takes the warm one, ends a mismatched one, `close`, no setup.
  - `MCP_TOOL_TIMEOUT`.
  - The shim honouring a hold past its limit.
  - `ReplyStream`'s first words.
- **Rust (+2, and 2 extended):** a dev run writes no bytecode, `mcp_hold`'s file; the release launch and the shim launch check the prefix.
- **Vitest (+42), with existing tests updated:**
  - `SettingsPanel` 3, and About's Restart and Refresh 1.
  - Composer: queue 2, mentions 2.
  - `mentions` 4.
  - Controller: queue 4, mentions 2, warm start and timing 4, review 5.
  - `toolKinds` 2, ToolCards review 2, `notify` 4, `chatHistory` 2.
  - The store's queue 1, MiniPlayer 1, StatusBar 1, MessageList chips 1.
- **All green:** pytest 757 (+2 skipped), cargo 130, vitest 581, ruff, mypy, eslint, tsc, clippy, `npm run build`.

### Checked live
- **The Claude Code probes and timings above.**
- **Review with Claude Code:** a real `add_markers` call held for 130 s with `.hold`, past the shim's 120 s, then answered at 132.9 s; Claude replied "Done. I added one marker named \"Hook\" at 1 second." (134.7 s). A first run failed with "quit before answering" because the stand-in app wrote its heartbeat non-atomically; the real app uses `write_atomic`.
- **Not yet:**
  - The app itself: the tabs, queue, mentions, review cards and notifications. Notifications need the installed app (`npm run install-app`): macOS asks to allow them once.
  - A review card on a scratch Resolve timeline.

## Phase 12: More of the agent's actions done in the editor itself (2026-10-08)

The user's goal for this phase: more of what the agent does should happen inside Premiere and Resolve. They chose to keep cuts by content in drafts (a NEW timeline), and to add speed, transitions, tracks, and organizing the Media Pool / bins (12b–12e). Timeline-clip colour and names come later.

### 12a: send_to_premiere built inside Premiere
**The bug (seen by the user):** a resequence "round-tripped and imported new copies". `send_to_premiere` wrote the draft as XML, and the panel imported it (`vcImportSequence`). Premiere then makes a new master clip in the "VibeCut" bin for every source in an XML, even a file the project already has, and the clips' effects stay behind. Resolve's rebuild never did this: it imports with `importSourceClips: False` and uses the Media Pool's own clips.

**First version, since replaced (see "12a, revised" below): moving the clone's own clips** (`nle/premiere_native.py`, called by `premiere_rebuild.rebuild` when the request has a `layout`):
1. `clone_sequence` (panel `vcCloneSequenceInto`) copies the connected sequence into the "VibeCut" bin and opens it. Clips keep their effects, Lumetri and keyframes.
2. `remove_transitions` clears the clone's transitions; the XML rebuild never carried them either. The result warns.
3. Each draft clip with an `originId` (every clip `draftFromSnapshot` made) is found in the clone where it was cut from:
   - `razor_cuts` (QE, up to 200 cuts per call) cuts the tracks at its edges;
   - `remove_items` lifts every piece no draft clip uses;
   - `move_items` moves the rest in two passes: everything past the end first, then each to its start (`moves: [{id, offsetTicks}]`, new), so no move ever lands on another clip;
   - `set_items` sets on/off and levels where the draft differs, and `set_links` relinks each picture with its sound.
4. A draft clip without a clip of the original to come from (B-roll the draft placed, a Story Editor cut, a second use of the same source range) goes through `premiere_edit.add_clips`. It uses the project item already there for that file (`vcProjectItemFor`) and imports only a file the project doesn't have. Missing tracks are added first.
5. The clone's markers are replaced by the draft's.
6. Any failure deletes the clone (`delete_sequence`). The original is never touched.

**Still from XML:** a clip with a speed ramp, or a new clip at another speed. The result says so, along with the copies it imports.

**What else changed:**
- **App side:** `draft.ts` sends `layout` (`nativeLayout`) for Premiere, and its summary says when nothing was imported. The prompt now tells the agent that Premiere keeps the clips' effects.
- **Panel 0.9.0:** new commands `clone_sequence`, `razor_cuts`, `remove_transitions` and `delete_sequence`. `move_items` now takes `moves`. Every one is checked in `bridge.js`, and `move_items` gained a check it didn't have.
- **Timeouts:** the panel gets 120 s for a clone or razor batch. Rust's `rebuild` wait is 200 → 300 s.
- **Not removed:** the copies made by earlier sends are still in the "VibeCut" bin; nothing deletes project items automatically.

**Tests:**
- `test_premiere_native.py` runs against a fake panel that keeps a real sequence and refuses a move onto another clip. It checks:
  - a resequence of A/B with linked sound: the pieces, places and links, the original unchanged, no `import_sequence` call, markers replaced, transitions removed;
  - a clip placed from the project;
  - a failed cut, which deletes the clone;
  - levels and on/off;
  - which drafts `plan` leaves to XML.
- `bridge.test.ts`: the new checks.
- `transcriptTools.test.ts`: the layout names the original's clips.

**Live:** this needs Premiere. The user presses Settings → Editors → Update panel (0.9.0) and restarts Premiere, then tries a rearrange + send on a copy of a sequence. The "VibeCut" bin should gain only the new sequence.

### 12a, revised (2026-10-09): placing the pieces, not moving them
**What went wrong live (Premiere 26.5.2, the user's "Best B-Roll Selects", 180 clips at 59.94 fps):**
- **First the panel was too old.** The first send failed with "Unknown command: clone_sequence": Premiere was still running panel 0.8.0, loaded before Update panel. The bridge now says to restart Premiere.
- **Then the move build lost most clips.** It "succeeded": the panel's reading listed all 180 clips in name order, but Premiere's timeline showed four picture clips and one sound clip, and an end of 5:50.
- **Probes on a copy ("VCA probe", deleted afterwards):**
  - Every clip was looked up once, and then each was moved through that handle. Six clips moved that way read back as moved, but Premiere didn't move them. The panel now looks each clip up again just before it moves or removes it (`vcMoveItems`, `vcRemoveItems`, `vcNestRange`).
  - That fix alone didn't save the full resequence: the user's screenshot still showed the clips gone, even after closing and reopening the sequence.
  - The end Premiere reports (`sequence.end`) isn't a check either: it follows the last clip moved.

**Now (`premiere_native.py`, rewritten):**
- The copy keeps only the sequence's settings, tracks and names. Its clips and transitions are lifted.
- Each draft piece is placed with `place_clip` from the project item its original clip used, or the one for its file, found by path; only a file the project lacks is imported. A picture and its sound from the same moment of the same file go in as one placement, and any half the draft doesn't have there is lifted again at once.
- Levels and on/off are set, every piece is checked on its track at its start, and on any failure the copy is deleted.
- **Costs:** effects, Lumetri, keyframes and transitions don't come across, as with XML. Pieces take their project item's name ("…_02", not "…_02 (seg 1)"). A speed change or ramp still goes through XML.
- `razor_cuts` and the move command's per-clip `moves` are now unused by the rebuild, but kept in panel 0.9.0.

**Checked live (2026-10-09):** the user's resequence rebuilt in 31 s as 90 placements from the project's own items, with nothing imported. The reading shows V1 at 90 clips, A1 and A2 at 45 each, all to 10:25.6, and Premiere's end reads 625.6 s. The user's screenshot confirms the picture in name order with its sound beneath.

**Panel:** `host.jsx` was copied straight into the installed extension (the panel loads it fresh for every call), so this needed no restart. `npm run install-app` is needed for the sidecar's new `premiere_native.py`.

### 12b–12d: Speed, transitions, tracks and track switches
All four are ported from VibeCut (verbatim except the import paths) and are direct edits: a backup first, the edit log, then Revert.

**Python:**
- `set_clip_speed` and `revert_speed`, plus `add_track`, `remove_track` and `revert_track`, are in `premiere_timing.py` and `resolve_timing.py`. Their docstrings already described these before they were ported.
- `set_transition` and `revert_transition` for Premiere are in `premiere_effects.py`. Resolve's was already there for duck_music.
- `set_track_options` and `revert_track_options` are in new `premiere_structure.py` and `resolve_structure.py`, which hold only those (links stay in `links.py`).
- All are registered in `edits.py`, and both hosts' `revert_timeline_changes` now take `speed`, `transition` (Premiere), `track` and `trackOptions`.

**Panel:** `vcSetSpeed` (asked again until the speed holds, up to 12 times), `vcAddTransition`/`vcRemoveTransition`, and `vcSetTrackOptions`/`vcTrackState` are VibeCut's, with their `bridge.js` checks. `set_speed` gets 60 s.

**Tools** (`src/lib/agent/timingTools.ts`; all in `CHANGING_TOOLS`, so they're reviewed when "Review edits first" is on):
- `set_clip_speed`: constant speed. `ripple` moves later clips. Resolve does that on the timeline itself. Premiere can't from a script, so a ripple there goes into a draft via `setDraftSpeed`, as does any speed change while a draft is open.
- `set_transition`: dissolve, dip to black, or none, on the cut after a clip.
- `add_track` and `remove_track`: the last empty track.
- `set_track_options`:
  - Premiere: enabled/muted, locked, targeted, syncLocked;
  - Resolve: enabled and locked, on the open timeline only;
  - no solo in either editor.

**Prompt and descriptions:** the prompt no longer says speed and transitions can't be done. `describeTimelineChange` words `speed`, `track` and `trackOptions` as VibeCut does.

**Not ported:** speed ramps, reverse, `harmonize_takes`, `swap_clips`/`move_clips_by`.

**Tests:**
- VibeCut's own, against the port's fakes:
  - Premiere speed ×4 (one of them a split after a speed change) and tracks;
  - Premiere transitions ×3;
  - Resolve speed ×3 and tracks;
  - track options for each editor.
- `timingTools.test.ts`: the requests, the Premiere ripple going to a draft, the refusals, the wording.
- `bridge.test.ts`: the panel checks.

**Live:** Resolve checked 2026-10-09 (see below). Premiere needs panel 0.9.0 and a restart.

### 12e: Organizing the Media Pool / Premiere project
**Python:** `premiere_organize.py` and `resolve_organize.py` are VibeCut's, verbatim apart from the import paths and two type annotations. Each has six commands, registered in `project.py`:
- `create_bins`, `move_clips`, `rename_clips`;
- `set_clip_labels`: Resolve's clip colour and flags; Premiere's label, which can't be cleared;
- `set_clip_metadata`: logged fields, plus keywords on Resolve. Premiere's keywords live in the media's XMP, which VibeCut never writes;
- `revert_pool_changes`.

Every change is `{clipId, field, before, after}`. The project's own media files are never touched.

**Panel (0.9.0):** `vcCreateBin`, `vcMoveProjectItems`, `vcSetProjectItems` (through the project's own XMP) and `vcDeleteBin` (empty bins only) are VibeCut's, with their `bridge.js` checks.

**Tools** (`src/lib/agent/poolTools.ts`, from VibeCut's `poolChanges.ts` and `poolSpec.ts`): `create_bins`, `move_clips`, `set_clip_labels`, `set_clip_metadata` and `rename_clips`. Clips are named by their short pool ids ("p3"). All five go through review.

**How it differs from VibeCut:**
- **One log, one Revert:** VibeCut kept a separate pool log with its own `revert_pool_changes` tool. Here each change goes in the same edit log as the timeline edits, as an entry with `pool: {changes, createdBins}` and no backup. `revertTimelineEdits` sends such an entry to `revert_pool_changes`, so the chat's Revert and `revert_timeline_edits` undo a request's project and timeline changes together. A bin the agent made is removed only once it's empty.
- **Review cards** name pool clips by their names.

**Not done:** colour and names for clips on a timeline (the user's choice: later; it needs a probe first).

**Tests:**
- VibeCut's `test_resolve_organize.py` and `test_premiere_organize.py` (21), against the port's fakes. One import in the ported `premiere_fakes.py` was still VibeCut's and had never run.
- `poolTools.test.ts`: ids, the log, refusals, Revert together with a timeline edit, the per-editor declarations, review.
- `bridge.test.ts`: the panel checks.

**Live in Resolve (2026-10-09):** see "12b–12e checked live in Resolve" below. Premiere: after Update panel.

### 12b–12e checked live in Resolve (2026-10-09, Resolve Studio 21.1, "VibeCut 7a")
**Setup:** a real `resolve-watch` from the repo, driven by a scratch script. "Bakery (VibeCut 1)"'s media had gone offline, so a 40 s test clip was made with ffmpeg (testsrc2 + a sine). A new timeline, "VCA 12 live", got four linked clips from it through `add_clips`.

**What each edit did:**
- `backup_timeline`, then a 0.5 s dissolve on the first cut: Resolve placed it at 2.72–3.24 s, centred on the 3.0 s cut.
- Clip 2 at 0.5x without ripple: same place and length, source 8.0–9.5 s.
- Clip 3 at 2x with ripple: it became 6–8 s, and clip 4 moved from 10 s to 8 s, on V1 and A1 alike.
- Add V2, add A2, remove A2.
- Lock A1, switch V1 off.
- In the Media Pool: clip colour Orange plus a Blue flag, Comments and a keyword, a rename, and a move into a new bin "Master/VCA 12 bin".

Every change read back as asked.

**Revert, newest first:**
- The four pool changes: the new bin was removed.
- The eight timeline changes: every one reverted, nothing changed since, nothing failed or lost.
- The timeline then matched its first read clip by clip (place, source range, on/off, speed), with the same tracks and switches. The pool clip's name, bin, colour, flags and metadata were back as well.

**Cleanup:** "VCA 12 live", its backup and an unused "VCA 12 test" copy were deleted, along with the imported test clip. "Timeline 28" is current again.

## Phase 13: An agent that sees, hears and remembers (2026-10-09)

The user wants the agent to be more aware of the timeline, media and project. They chose all four parts:
- 13a: a sharper snapshot;
- 13b: seeing the footage;
- 13c: project memory;
- 13d: hearing the audio.

Each part ships on its own. The engines for 13a, 13b and 13d live in one package, `vibecut_agent/media/`, with one-shot sidecar commands run through `media/commands.py`, and read files with the local ffmpeg only.

### 13a: A sharper snapshot
**The first line** now says where the user is: `…; playhead at 72.2s, In 30.0s – Out 120.0s marked`.
- **Premiere** (panel 0.9.1): `vcReadSequence` adds `playheadTicks` (open sequence only), `inTicks` and `outTicks`. `premiere.timeline` (`_whereabouts`) leaves out unset marks. Premiere reads both as -400000 s, which shows up as an In at the start with an Out not after it. An older panel sends neither, and nothing breaks.
- **Resolve:** `read_timeline` adds the playhead (`GetCurrentTimecode`, open timeline only) and `GetMarkInOut()`. The picture's marks win; Out is included, as in VibeCut's `resolve_render.py`.
- `HostTimeline` gains `playhead?` and `inOut?`. The prompt says "here" or "this shot" means the playhead, and the marked part means In–Out. `get_playhead_time` is only for after the playhead may have moved.

**New lines after the pool** (`context.ts` `awarenessFor`). Each is best effort: a failure drops the line, never the snapshot.
- **`[SOURCES]`** (`mediaInfo.ts`): each file on the timeline (up to 40), e.g. `"A.mov": h264 3840x2160 23.976 fps · aac 2 ch 48 kHz · 12:03`.
  - **Engine:** the new `media-info` command (`media/info.py`, ffprobe; up to 64 files). Cover art is skipped.
  - **Caching:** each file is read once a session. The snapshot waits at most 1.5 s for new files; the rest show "(format not read yet)" until a later message. A file that failed is tried again after a minute.
- **`[TRANSCRIPTS]`** (`awareness.ts`): which heard files (sound on, clip on) have a transcript, with their speakers' names and roles, and which don't yet.
  - **Caching:** a transcribed file is read once. `transcribe_clips` forgets the files it wrote.
- **`[B-ROLL]`:** what `find_broll` searches: the Library's ticked folders, or the whole archive. It reads only the store, never Spyglass.

**Also:**
- Pool lines show each clip's fps.
- **New tool `get_edit_log`** (read only, works while drafting): every edit and project change, oldest first and grouped by request, with editId, time, tool, timeline, summary, reverted or live, and backup. `lastStep=true` gives the latest request's only. Capped at the newest 100 (`edits.ts` `editLogFor`).

**Tests:**
- `awareness.test.ts`: the first line, [SOURCES] (read once, never holds up the snapshot, the limit), [TRANSCRIPTS] (heard files only, names and roles, caching, forgetting), [B-ROLL], `get_edit_log`.
- `tests/media/test_info.py`: ffprobe facts, plus a real ffmpeg file and a missing one.
- `test_premiere.py` and `test_resolve.py`: the playhead and the marks, unset marks, a closed timeline, an older panel.

### 13b: Sees the footage
**Tools** (`visionTools.ts`; read only, not reviewed, work on a draft too):
- `look_at_clip`: `{clipId, times? (timeline s), count? (default 6)}`. Frames of a video clip, with timeline time mapped to file time through the clip's source in and speed (a reversed clip counts back).
- `look_at_timeline`: `{times? | start/end + count (default 8)}`. Without times or a range, it uses the In–Out marks, else the whole timeline.
  - At each time it reads the clip on the highest video track that's on (clip on, with a file).
  - Moments with no picture come back as `gaps` ("black").
- `look_at_media`: `{clipId (pool "p3") | filePath, times? (file s) | start/end + count}`. The length comes from the pool, else from `media-info`.
- **What each returns:** a contact sheet (one image), plus a result naming each numbered frame (label, file, file time) and any frame it couldn't read. Every description says the frames are source pictures, without the editor's effects, grade or titles.

**Engine:** `media-frames` (`media/frames.py`).
- Up to 12 shots `{path, time, label}`. ffmpeg seeks fast to each frame (4 at a time), and a time past the end gives the last frame, reported as such.
- Pillow tiles them into one JPEG at most 1536 px wide (1–4 columns), each frame numbered over its label; a frame it couldn't read is a grey tile. Each image is kept under 3.75 MB.
- `sheet: false` gives up to 4 separate frames.

**Budget** (`turnImages.ts`): 2 images per call and 8 per request (`context.step`).
- The tools refuse before reading frames once the budget is used up.
- `withImagesKept` (controller) trims a result to the budget and says so in `imagesWithheld`.

**Images in tool results:**
- `ToolOutcome.images` → the controller sends `tool_result {…, images}`.
- **Claude API:** the `tool_result` content becomes `[text, image…]` (`attachments.claude_tool_content`).
- **Gemini:** `inline_data` parts follow the turn's `functionResponse` parts, each lot introduced by "The images <tool> returned:" (`gemini_tool_parts`).
- **Claude Code:** `McpReply.images` goes through the bridge, and the shim (`mcp_server.ask_reply`, `text_result`) adds `ImageContent` blocks.
- **History:** a turn's returned history replaces tool images with `TOOL_IMAGES_NOTE` (`without_tool_images_*`), so they aren't resent with every message. The user's own images stay.
- **Bad images:** a bad or extra image is dropped (`tool_images`), and the call still stands.
- **MCP:** `isReadTool` counts `look_at_*` and `measure_*`, so outside clients can use them while a chat runs.

**Cards:** a tool card shows the images it returned. They're filed beside the chat like 8g attachments (`saveToolImages`, ids `tool-…`), and `SentImage` moved to `components/chat/ChatImage.tsx`.

**Tests:**
- `visionTools.test.ts`: spreading, file-time mapping with speed and reverse, the picture seen, each tool, refusals, the budget and holding images back.
- `tests/media/test_frames.py`: real ffmpeg, i.e. pixel colours, the sheet, past the end, a missing file, and nothing readable.
- `tests/agent/test_tool_images.py`: Claude and Gemini requests carry the images, the history keeps the note, and the user's images stay.
- `test_mcp_server.py`: `ImageContent` reaches the client.

**Checked live (2026-10-09):**
- **Gemini** (repo key): a red-then-green test clip's sheet went back from a stand-in `look_at_clip`. Answer: "frame 1 is red … frame 2 is green". The history came back without the image.
- **Claude Code** (2.1.292, Work profile, Sonnet): it went through the real MCP shim (`python -m vibecut_agent mcp`) with a scratch stand-in app on the bridge folder. Answer: "Frame 1 (0.5s) is red, and frame 2 (3.0s) is green."
- **Claude API:** not checked live; the repo `.env` key still returns 401.

### 13c: Project memory
**Store** (`project_notes.rs`, commands `project_notes_get` / `project_notes_set`):
- One Markdown file per editor project in `<app data>/projects/`, named `<editor>-<slug>-<FNV-1a 64 hex>.md`. A project is its editor plus the name the editor gives it.
- At most 16 KB, written atomically, in a folder only the user can read. Saving empty notes removes the file.

**Snapshot** (`context.ts`): the notes come first, read beside the timeline and pool.
- With notes: `[PROJECT NOTES for "<project>" …]` … `[END PROJECT NOTES]`. Without any: one line saying how to start them.
- Failing to read the notes leaves the block out, never the snapshot. The MCP `get_editor_context` gets the notes too.

**Tools** (`notesTools.ts`; not reviewed, since they don't touch the editor):
- `remember_note {section: brief|people|style|deliverables|decisions, text}` adds `- text (date)` under `## Section`.
  - The section is made in that order when missing; the user's own text and headings are kept.
  - A line already there (ignoring case and spaces) isn't added twice. Lines are under 300 characters, and full notes refuse more.
- `forget_note {text}` removes the one line containing every word of `text`. When several match, it lists them; an emptied heading goes too.
- The pure text functions are in `src/lib/projectNotes.ts`.

**Prompt:** follow the notes without being told again; `remember_note` lasting facts and preferences the user states ("the client is…", "always…", "never…", deadlines), and say so. Never save guesses or one-off requests.

**UI:**
- **Notes** in the status bar, or ⌘⇧N, opens `ProjectNotesModal` (a new overlay `"notes"`): a plain Markdown textarea for the project open now.
- It saves on Save, on ⌘S and on close, with a size check. It's disabled when no project is open.

**Tests:**
- `project_notes.rs`: names, round trip, the cap.
- `projectNotes.test.ts`: sections and order, de-duplication, matching, removal, the snapshot block, ⌘⇧N, both tools.
- `ProjectNotesModal.test.tsx`.
- `context.test.ts`: the whole snapshot with notes, [SOURCES], [TRANSCRIPTS] and [B-ROLL], and notes that can't be read.

**Checked live (Gemini, 2026-10-09):** with the real tool declarations and rule:
- "The client is Rosa's Bakery and they never want whip pans. Also, make this cut 60 seconds for Instagram." gave three `remember_note` calls (brief, style, deliverables), and the reply said what was saved.
- "Add a marker at 10 seconds for now." saved nothing.

### 13d: Hears the audio
**Tools** (`audioTools.ts`):
- `measure_loudness` (read; not reviewed): EBU R128 per sound clip — integrated LUFS, loudness range, true peak, loudest 3 s — plus each clip's level now.
  - **Which clips:** `clipIds` (a picture's id measures its linked sound), or `start`/`end`; without either, the In–Out or the whole timeline, every heard clip (track and clip on), cut to the range.
  - **Up to 32 clips.** Each is its own file over the part it plays (through speed and reverse), before its level, fades and the mix; the description says so.
- `normalize_loudness` (an edit, reviewed, refused while drafting): `{clipIds, targetLufs (default -14; -16, -23, -24 named), maxTruePeak (-1 dBTP; null for none)}`.
  - Each clip's level becomes `target − measured`, held to ±20 dB, and lowered so its true peak stays under the ceiling. The result says which clips fell short, and silent clips are skipped.
  - It applies through `editExecutors.set_clip_levels`, so the change gets one backup and one Revert.
- `find_beats` (read): `{clipId, start?, end?}` gives BPM, confidence, beats as timeline times (through the clip's speed), and `maybeDoubleTime` under 95 BPM.
  - **Change from the plan:** it doesn't add markers itself, because `add_markers` isn't in the edit log. The model calls `add_markers` (reviewed) for the beats it wants.

**Engines:**
- `media-loudness` (`media/loudness.py`): up to 32 ranges, 4 at a time. ffmpeg `ebur128=peak=true:framelog=verbose` at `-v verbose`, parsing the summary and the per-frame `S:` lines. The first sound stream is measured, and silence gives `null`.
- `media-beats` (`media/beats.py`): numpy over `peaks.decode` (8 kHz mono).
  - **Method:** a spectral-flux onset envelope (512/128), tempo by autocorrelation between 60 and 200 BPM weighted toward 120, and Ellis's dynamic-programming beat tracker.
  - **Limits:** 4 s to 20 min per call. Outputs are cast to Python floats (numpy 2 keeps float32, which the protocol would write as a string; caught by a test).

**MCP:** the three tools get the 15-minute timeout (`LONG_TOOLS`).

**Tests:**
- `audioTools.test.ts`: file parts through speed and reverse, linked sound, heard clips in a range, the level maths, each tool, `set_clip_levels` with one backup, refusal while drafting, beats onto the timeline at 2× speed.
- `tests/media/test_loudness.py`: a real -23 LUFS tone within 0.5, silence, a missing file, the parser.
- `tests/media/test_beats.py`: 90, 120 and 128 BPM click tracks within 1 BPM and beats within 40 ms, 174 → 87 with `maybeDoubleTime`, noise below 0.3, a part of a file.

**Measured while building:** synthetic clicks gave 89.8, 120.4 and 128.5 BPM, with median beat error 10–14 ms.

### Phase 13 checked live in Resolve (2026-10-09, Resolve Studio 21.1, "VibeCut 7a")
**Setup:** a scratch Vitest harness ran the app's own TS tools (`executorsFor`, `snapshotFor`, the edit log and Revert) against a real `resolve-watch`, with the real Python media jobs. Only the Tauri boundary was replaced.
- **Media:** two generated files, `VCA13_picture.mov` (20 s testsrc2 at 1280x720/25, with a 440 Hz tone at -30 dBFS) and `VCA13_clicks.wav` (30 s, 120 BPM).
- **Timeline:** `create_timeline` "VCA 13 live", then `add_clips` put both on it (picture on V1+A1, clicks on a new A2).

**13a:**
- With the playhead set to 4 s and the In/Out marked at frames 50–149, the snapshot's first line read "…; playhead at 4.0s, In 2.0s – Out 6.0s marked".
- `[SOURCES]` read `"VCA13_picture.mov": h264 1280x720 25 fps · pcm_s16le 1 ch 48 kHz · 0:20`; `[TRANSCRIPTS]` said "0 of 2" and named both files.
- The notes line came first, and pool lines showed fps.

**13b:**
- `look_at_clip` (4 frames) gave a 1536x926 sheet, and `look_at_timeline` (no args, so the In–Out) gave 2 frames.
- The burned-in timecodes matched to the frame: 3.000 and 5.000 exactly, and 2.520 for 2.5 s (the next frame).
- **Fixed after the run:** `look_at_timeline` labelled frames with Resolve's 36-character clip ids, which crowded the sheet. The label is now the clip's name, and the id moved to the result's `frames[].clipId`.

**13d:**
- `measure_loudness`: the tone read -33.8 LUFS with a -30.1 dBTP peak, as expected for that sine; the clicks read -28.3 LUFS.
- `normalize_loudness` to -20 set A1 to +13.8 dB, under its own backup "(before VibeCut 2)", and the level read back as 13.8.
- Measuring again confirmed `levelDb` 13.8.
- `revert_timeline_edits` on that edit reverted 1 change, and both clips' levels were back to 0 exactly.
- `find_beats` on the clicks (to 10 s) found 120.4 BPM (confidence 0.86), 20 beats each within 16 ms of the true clicks.
- Every 4th beat went to `add_markers` (4 markers, at frames 6, 56, 106 and 156), and `remove_markers` took them all away.

**Jobs:** each took 220–430 ms. No watcher call failed.

**Cleanup:**
- Deleted: "VCA 13 live", its two backups, and both test clips. 28 timelines remain, and "Timeline 28" is current.
- Left in place: the empty "Master/VibeCut" bin, the app's import bin, used by earlier checks too.

### Phase 13a checked live in Premiere (2026-10-09, Premiere 26.5.2, panel 0.9.1)
Read only, through `PremiereBridge`/`PremiereHost`, on the user's "Best B-Roll Selects" (59.94 fps, 180 clips, project "2026 Agent Tests").
- **Unset marks:** with no marks, the panel sent In = Out = -101606400000000000 ticks (-400000 s), not 0 and the end as first assumed. `_whereabouts` already left them out; the comments are corrected, and a test with these exact readings was added.
- **Marks set by the user** (I and O, with the playhead moved):
  - playhead 242.142 s, frame 14514, matching `get_playhead`;
  - In 118.085 s, frame 7078;
  - Out 242.159 s, the end of frame 14514: one frame after the playhead where O was pressed, so Out includes its frame, as in Resolve.

**Still to check:** the user's own try in the app: Notes (⌘⇧N), tool cards with frames, and remembering across a new chat.

## Phase 14: An agent that checks its work, cuts for social and to the beat (2026-10-09)

The user asked what other skills the agent should have. Of four groups (deliverables, review & QC, social & music, a saved prompt pack) they picked the last three. Captions and renders are left for later. The parts:
- 14a: `review_edit`, the automatic check;
- 14b: the vision critic;
- 14c: cut to the beat;
- 14d: vertical, square and 4:5 versions;
- 14e: the prompt pack.

### 14a: `review_edit`, the automatic check
**Ported verbatim** into `src/vibecut/` from VibeCut, with their tests:
- `editLint.ts`: black, flash frames, cuts inside a word, level jumps, clipping, out of sync;
- `transitions.ts`, `trackState.ts`, `playback/envelope.ts` and `types/export.ts`.

`lib/export/flatten.ts` is cut down to `buildVideoSegments` and `clipHasOwnAudio`, without the grade keys. That keeps out VibeCut's 665-line colour graph, which the lint never uses.

**`src/lib/agent/reviewTools.ts`:**
- `lintTimeline` is VibeCut's `hostLintTimeline` over this repo's `HostTimeline`:
  - each file is one asset by `fileKey`;
  - link groups come from `linkGroups`;
  - the connection's sync offsets go on the picture's asset;
  - picture items are silent.
- `withWordsAndPeaks` reads the transcripts (`read_transcript`) and one `audio-peaks` job for the heard files, best effort.
- **Delivery checks** (`deliveryChecks`, pure):
  - `offline` clips;
  - `switched_off` clips, and tracks that are off with clips on them;
  - `past_end`: a short last stretch at least 2 s after the edit ends (at most 10 s, or 20% of the edit);
  - `no_sound`: picture with nothing heard under it for 1 s or more. It only runs when the timeline has sound at all, and a clip at -60 dB or lower counts as silent.
- **With `targetLufs`:** `loudnessFindings` reports each heard clip in the range that plays (measured plus its level) more than 1 LU off, or peaks over -1 dBTP. It uses `measure` (now exported from `audioTools.ts`), for up to 32 clips.
- **Ordering:** findings are in time order, with at most 60 kept, the most severe first.
- **Repeats:** VibeCut's memo is ported. The same review of an unchanged timeline within 10 minutes answers from the last one, with `UNCHANGED_REVIEW_NOTE`.

**Tool** `review_edit {startTime?, endTime?, targetLufs?}`:
- Read only (`NOT_REVIEWED`), and it works on a draft.
- MCP `isReadTool` now takes `review_`, and the tool is in `LONG_TOOLS`.
- The prompt gains `REVIEW_INSTRUCTION`: review after a substantial edit, pass the target before a delivery, and call it once per batch.

**The card:**
- `ToolOutcome.findings` reaches `ChatToolCall.findings`. `ToolFinding` lives in `types/agent.ts`.
- `ToolCards` lists them, each with a `TimecodeChip` that moves the playhead, the severity, and "Critic:" for 14b's notes.
- Saved chats keep them (`isFinding` in `chatHistory.ts`). A card with malformed findings becomes a plain line.

**Tests:**
- `reviewTools.test.ts` (11):
  - the lint's view: links, a silent picture, offline media, sync offsets;
  - each delivery check and its range;
  - loudness after level, and true peak;
  - ordering and the cap;
  - the tool end to end: a cut inside "hello", a flash frame and black found; the loudness range in file time; the memo and a fresh review after a change; refusals.
- The ported `editLint`, `transitions` and `trackState` tests.
- `ToolCards` (findings rows) and `chatHistory` (findings kept or dropped).

### 14b: The vision critic
**Python** (`src-python/vibecut_agent/review/critic.py`, a new package, bundled): the `critique` sidecar command, ported from VibeCut's `gemini_critic.py` and its headless `run_critique`.
- **Kept verbatim:** the rubric, the schema, the finding clean-up (`findings_from`), the captions and the parts. The sentence about editor-rendered stills is dropped, since there are none here.
- **Frames:** read with `media/frames.py`'s `grab` (384 px JPEGs, 4 at a time) and sent inline, never written to disk. An unreadable frame is left out and counted in `framesFailed`.
- **Providers:** any of the chat's three, through `story/models.py`, at medium effort (Gemini at temperature 0.3).
  - The general calls now take Gemini-shaped parts as well as text: `gemini_user_parts` for Gemini, `claude_user_content` (`to_claude_content`) for the Claude API.
  - Claude Code: `claude_code_json.run_json` takes content blocks and then runs with `--input-format stream-json`, one user line, as the chat does (8g). Text-only runs (the Story Editor, the first pass, titles) are unchanged, and the lockdown check is the same.
- **Rust:** `critique` is in `COMMANDS` and `needs_llm_key`, so the key or the Claude Code setup is injected as for `chat-title`.

**App** (`reviewTools.ts`): `review_edit` gains `visual` (default true) and `brief` (default: the user's last message).
- **Stills:** VibeCut's `sampleFrames`, verbatim, over `visibleVideo`: two frames in from each end of every visible shot, plus the middle of shots over 4 s, at most 24. Titles have no file and are skipped.
- **The words:** `transcriptExcerpt` (verbatim) over the heard clips' `laneLines`, with the speakers' saved names.
- **The rest of the request:** the timeline layout from `timelineLines`, the automatic check's findings, and the chat's provider and model.
- **Merging:** the critic's notes join the check's in the result (`critic: {overall, findings, stillsSeen}`, or `{skipped: why}`), the summary, and the card (as "Critic:" rows, with the fix).
- **Failure:** a failed critic leaves the automatic check standing and says why.
- **Context:** the stills never enter the chat, so they don't count against the 8-image budget.
- **About** now says that review_edit's critic sends stills and what is said, for each provider.

**Tests:**
- `tests/review/test_critic.py` (9):
  - well-formed findings only;
  - parts and captions;
  - frame checks;
  - each provider's request carrying the images: Gemini `inline_data`, Claude image blocks at medium effort, Claude Code blocks with the converted schema;
  - failures without the key;
  - real ffmpeg frames.
- `test_claude_code_json.py`: blocks go in as one stream-json line, and text doesn't.
- `sidecar.rs`: key and setup injection for `critique`.
- `reviewTools.test.ts`: the request (model, brief, stills, words, check), the merged result and card rows, and a failed critic.

**Checked live (2026-10-09), on generated media** (testsrc2 twice across a cut at 5 s, then a heavily blurred shot), with the real `critique` command:
- **Gemini** (repo key): "high · framing · 9.0 s: severely out of focus" and "medium · continuity · 5.0 s: abrupt jump cut on identical framing". It also noted the burned-in timecode.
- **Claude Code** (2.1.292, Work profile, Sonnet): the same two, plus the jarring cut into the soft shot and "no product shown". The lockdown check passed with the stream-json input.

### 14b, revised: the critic on Gemini Flash by default (2026-10-09)
**Decision (the user):** they would rather pay for Gemini's API than the Claude API's per-token billing.
- **Before:** the critic ran on the chat's model, so chatting on Claude Opus or Sonnet (API) billed every review to the Claude API. On the subscription, it used up plan limits.
- **Now:** Settings → Agent → "Edit review critic" offers Gemini Flash (the default) or "Same model as the agent". It's saved as `criticModel` in `useAgentStore`.
- **`criticModel()`** (`reviewTools.ts`) sends `provider: "gemini"` with no model, so `gemini-flash-latest` is used, the request checked live in 14b. This happens whenever the setting is Gemini and `useSystemStore.keys.gemini` says there's a key.
  - **No key:** it falls back to the chat's model, and the summary says "there's no Gemini key, so the critic ran on …".
  - **Rust:** no change; `critique` already injects the key for the provider asked for.
- **Reporting:** the summary and the result name the reviewer ("from the critic (Gemini Flash, 6 stills)"). The setting is part of the review's repeat key, so changing it gives a fresh review.
- **About:** says the critic goes to Gemini by default, whatever the chat model, and to Claude only when Settings says so.
- **Tests:**
  - `reviewTools.test.ts`: Gemini with a Claude chat, the fallback and its note, the chat's model when set to it;
  - `SettingsPanel.test.tsx`: the menu, its missing-key note and the change;
  - `useAgentStore.test.ts`: the setting is saved.

### 14c: Cut to the beat
**Tool** `cut_to_beats {musicClipId, shots: [{clipId | filePath, sourceIn?, sourceOut?}], start?, end?, everyBeats? (1/2/4/8, default 2), offsetFrames?, videoTrack?}` (`src/lib/agent/beatTools.ts`). It's a reviewed edit (`CHANGING_TOOLS`), refused while drafting, and in `LONG_TOOLS`.
- **The beats:** `beatsOf` is factored out of `find_beats` (`audioTools.ts`) and gives timeline times through the music clip's speed.
  - It refuses under 0.3 confidence, or with fewer than 2 beats.
- **The slots** (`beatSlots`): every Nth beat, moved by `offsetFrames` and snapped to frames.
  - The last slot closes N beats on, at the median beat spacing, or at the range end if that comes first.
  - Slots under 2 frames are dropped. At most 150 per call.
- **The shots** (`fillSlots`): taken in turn, each keeping a cursor through its usable range.
  - **Range:** the given in/out, else a pool clip's marked In/Out, else the whole file. The length comes from the pool, else `media-info`.
  - **Short shots:** a shot shorter than a slot is passed over. A slot nothing fits stays empty and is reported.
  - **Placing:** pool ids become paths through `filesOf`, so `add_clips` needed no change; the planned `clipSpec` change wasn't needed.
- **The track** (`freeVideoTrack`): the lowest video track with nothing on it over the stretch. If there's none, `add_track` makes one at the top in the same step.
- **One Revert:** everything is placed through `addClips` as picture only, in batches of 50 under the request's step, so one backup and one Revert undo it all, the new track included.
- **Prompt:** `BEAT_INSTRUCTION` says to use it rather than placing clips one by one. The review card reads "Cut to the beat with shots (n)".

**Tests** (`beatTools.test.ts`, 9):
- slots at 1, 2 and 4 beats, the closing slot, snapping, the offset and slivers;
- shots in turn, advancing and starting again, too-short shots, empty slots;
- the free track;
- the tool end to end: the pool's marked range, picture only, one backup and step; a new top track and two batches of a 64-shot cut; 2× music giving 240 BPM and cuts every 0.5 s; refusals (no steady beat, too many, a bad step, drafting).

### 14d: Vertical, square and 4:5 versions
**Probed live first (Resolve Studio 21.1, "VibeCut 7a", on scratch timelines):**
- A timeline takes its own frame size once `useCustomSettings` is "1". The original and the project keep theirs.
- **Resize modes** (`timelineInputResMismatchBehavior`): `scaleToCrop` ("scale full frame with crop") fills the frame. It also takes `scaleToFit`, `centerCrop` and `stretch`; `scaleToFill`, `fill` and `crop` are refused.
- **Smart Reframe:** `TimelineItem.SmartReframe()` exists and answers True in 1–6 s a clip, but Pan, Tilt and Zoom read the same afterwards. Its effect only shows in the picture:
  - an exported still (`Project.ExportCurrentFrameAsStill`) of a white box at x 1500–1740 of a 1920 frame put it at x 356–776 of the 1080x1920 frame;
  - a centre crop would have put it off the frame.

**`nle/social.py`:** the aspects, the sizes and the checks.
- `social_size` keeps the source's short side, rounded to even pixels (1920x1080 gives 1080x1920, 1080x1080 or 1080x1350).
- New names get "(9x16)", "(1x1)" or "(4x5)", made unique.

**Resolve** (`resolve_project.make_social_version`):
1. `DuplicateTimeline`.
2. Set the copy's own size with `scaleToCrop`, and read it back. If the size didn't take, it says so, naming the copy.
3. With `reframe: auto`, run `SmartReframe()` on each enabled video clip with media, up to 60.
4. The result says how many clips were reframed. When none could be, it notes that Smart Reframe needs Studio.

**Premiere** (`premiere_project.make_social_version`, panel 0.10.0):
- `vcAutoReframe` runs `sequence.autoReframeSequence(num, den, "default", name, false)` and opens the result. The bridge checks the ratio and the motion setting.
- `center` is refused: a scripted centre crop would mean setting each clip's Motion scale from its media size, which can't be checked from here.
- **Not checked live yet.** The user is to update the panel and try it.

**Snapshot:** `HostTimeline.width` and `height` come from Resolve's `GetSetting` and Premiere's `sequence.getSettings()` in `vcReadSequence` (0.10.0; an older panel sends neither). The first line now reads `…, 1080x1920, 25 fps, …`.

**Tool** `make_social_version {aspect, name?, reframe? (Resolve only)}` (`projectTools.ts`):
- It's reviewed like `duplicate_timeline`, and refused while drafting: send the draft first.
- It connects to the new timeline (`addMadeTimeline`).
- The watcher call gets the 300 s timeout (`nle.rs` `call_timeout`).

**Tests:**
- `tests/nle/test_social.py` (12):
  - sizes;
  - Resolve: the filled copy, its clips reframed (titles and switched-off clips skipped), unique names, centre-only, no Studio, a size that didn't take, bad arguments;
  - Premiere: Auto Reframe's request, and `center` refused;
  - both editors reading the frame size.
- `projectTools.test.ts`, `awareness.test.ts` (the first line), `bridge.test.ts` (the panel's checks) and `nle.rs` (the timeout).

### Phase 14 checked live in Resolve (2026-10-09, Resolve Studio 21.1, "VibeCut 7a")
**Setup:** a scratch Vitest harness ran the app's own TS tools against a real `resolve-watch`, with the real Python jobs, as in Phase 13.
- **Media:** generated files: `VCA14_picture.mov` (testsrc2 1920x1080/25 with a -48 dBFS tone), `VCA14_broll.mov` and `VCA14_clicks.wav` (120 BPM).
- **"VCA 14 live":** picture 0–8 s and 9–15 s on V1+A1, a 2-frame B-roll flash at 4 s on V2, a B-roll clip at 16–18 s switched off, and the clicks on A2.

**14a** (`review_edit`, `targetLufs` -14, `visual: false`) found 7 problems:
- the flash at 4 s (2 frames);
- black from 8 to 9 s and from 15 to 20 s;
- the switched-off clip at 16 s;
- both picture pieces at -51.8 LUFS and the clicks at -24.1 LUFS, all under the target.

**14c** (`cut_to_beats`, 0–8 s, every 2 beats):
- 120.3 BPM; 8 shots on a new V3 at 0.04, 0.96, 2, 2.96, 4, 4.96, 6 and 6.96 s, each within one frame of the clicks.
- Revert undid 9 changes (the shots and the track), and the timeline matched its earlier read exactly.

**14d** (`make_social_version` 9:16, auto) made "VCA 14 live (9x16)" in 3.6 s:
- 2160x3840 (the project is UHD), with Smart Reframe on 3 clips; the switched-off one was skipped.
- The original stayed at 3840x2160.
- An exported still of the copy at 2 s was filled from top to bottom, with no bars.

**Cleanup:** the test timelines, their backups and the test media were deleted. 28 timelines remain, and "Timeline 28" is current.

### 14e: The saved prompt pack
**Ten new starters** (`PACK_14` in `src/store/usePromptStore.ts`), using the Phase 12–14 tools:
- `/qc`: review_edit at a target, no critic, no changes;
- `/notes`: review_edit with the critic, for a brief;
- `/loudness-check`;
- `/describe-footage`: look_at_media, then set_clip_metadata;
- `/beat-markers`;
- `/beat-cut`: find_broll, then cut_to_beats;
- `/social-cutdown`: a draft at a length, then make_social_version;
- `/client-brief`: questions, then remember_note;
- `/chapters`;
- `/whats-changed`: get_edit_log.

`{{…}}` marks what to type over.

**Existing users:** the store is now version 2. Its `migrate` (`addPack14`) adds the pack once to a store saved before. It skips any name the user already has, keeps their own prompts as they are, and doesn't bring back a starter they deleted earlier.

**Tests** (`usePromptStore.test.ts`): names valid and unique, bodies within the limit, the pack's order, the migration (once, the user's own `/qc` kept, deleted starters stay deleted), and "cut" now matching `/rough-cut`, `/beat-cut` and `/social-cutdown`.

### Phase 14: still to check
- **The user's own try in the app:**
  - `/qc` and `/notes` on a real cut, with the findings card and its timecode chips;
  - `/beat-cut`;
  - `/social-cutdown`;
  - the new starters showing up after an update.
- **Premiere:** update the panel to 0.10.0 (Settings → Editors → Update panel), restart Premiere, then ask for a 9:16 version. Auto Reframe Sequence was not checked from here.
- **The critic on the Claude API:** the repo `.env` key still returns 401.

## Phase 15: The chat bot app, continued (2026-10-09)

### 15a: A tidier Agent row
The row above the messages had grown four text buttons ("Review on/off", "Revert N edits (earlier session)", "History", "New chat") and ran out of room at the 440px default and the 380px minimum. The user picked this layout:
- **Left: the open chat's name** ("New chat" before it is saved), with a ▾. Clicking it, or ⌘Y, opens History, which now drops down from the left. Its accessible name is "<title>, past chats" (`ChatHistoryMenu`).
- **Right: `Revert N`**, still a warning button. The full "Revert N edits (earlier session)" stays as its accessible name, and "earlier session" is in the tooltip. **New chat** is a pen icon.
- **Review edits first** moved into the composer: a shield switch next to Add images (blue when on), with the same switch role, label and tooltips (`Composer`).

Checked in the browser build at 380px with a long title and "Revert 12": the title truncates, nothing overlaps, and History opens under the title. Pending: the user's try in the installed app (`npm run install-app`).

## Phase 15: Deliverables: captions and renders (2026-10-09)
The last group from Phase 14's choice, built at the user's "continue". Both parts are ports of VibeCut code that was probed live there (its 13h and 7c), with their tests. Neither has been checked live from this app yet.

### 15a: Captions
**Editor side** (`create_captions`, VibeCut's code verbatim):
- **Resolve** (`resolve_edit.create_captions`):
  - `Timeline.CreateSubtitlesFromAudio` (Studio) on the timeline open in Resolve, with a language, characters per line and 1 or 2 lines.
  - Logged as a "captions" change with the subtitle ids and any new subtitle track. Revert deletes them, and the track if it's left empty and last.
  - An SRT placed on a subtitle track crashed Resolve in VibeCut's probe, so it's never done.
- **Premiere** (`premiere_edit.create_captions`): writes the cues as an SRT into the bridge's `imports/`, and the panel's `caption_track` (`vcCaptionTrack`, 0.11.0) imports it and calls `createCaptionTrack`.
  - Premiere can't remove a caption track from a script, so Revert reports it as failed and says to delete it in Premiere.
  - The imports folder is passed in through `premiere_edits(imports)`, as for rebuild.
- **Earlier stubs:** both edit modules had empty "captions (13h)" headings from earlier ports. Those are now filled in, with "captions" added to `REVERTIBLE`.

**App** (`src/lib/agent/captionTools.ts`):
- VibeCut's `captionCues` (verbatim) splits each transcript line into cues of at most `charsPerLine` characters, at whole words, timed by their words.
- Premiere's cues come from `heardLines` (new, exported from `transcriptTools.ts`). Heard files with no transcript are named in the summary.
- It's a reviewed edit, refused while drafting. Its change reads "12 captions on ST1".
- **Timeout:** the watcher call gets 30 minutes (`nle.rs` `CAPTION_TIMEOUT`).

### 15b: Renders
**Editor side** (VibeCut's `resolve_render.py` and `premiere_render.py`, verbatim apart from imports; `host_renders.py` becomes `nle/renders.py`):
- **Commands:** `render_video {preset: source|1080p|720p|prores, range, name?}`, `render_audio {format: wav|aac, …}`, `render_status` and `cancel_render`, registered in `project.py`.
- **Files** always go to `~/Movies/VibeCut Renders/<project>/` under a new name; the agent never gives a path.
- **Resolve:** the Deliver queue.
  - The user's Deliver settings, target folder, marks and page are saved and put back, and only the open timeline renders.
  - WAV is taken out of a small ProRes carrier with ffmpeg; AAC is renamed `.m4a`.
- **Premiere:** Media Encoder, through the panel's `encode` / `encode_cancel` (`vcEncode`, `vcEncodeCancel`, with Media Encoder's events writing `<bridge>/renders/<job>.<kind>.json`), using Media Encoder's own presets.
  - The bridge allows only those presets and only that output folder.
  - Stopping stops Media Encoder's whole queue, and the answer says so.
- **Timeouts:** `render_video` and `render_audio` get the 300 s timeout, since starting Media Encoder can take two minutes. Premiere's `caption_track` gets 60 s and `encode_cancel` 30 s.
- **Not ported:** `export_stills` and `save_stills`, which need the editor's own frame export.

**App** (`src/lib/agent/renderTools.ts`): `export_video` and `export_audio`.
- They start the render, poll `render_status` every second with the progress (and time left) as the activity line, and stop it with `cancel_render` when the chat is stopped.
- They answer with the file's path.
- They're refused while drafting, and not reviewed: they leave the timeline as it was.
- `RENDER_INSTRUCTION` says to render only when asked, and to suggest `review_edit` at the delivery target first.

**Prompt:** "can't do yet" is now speed ramps or reverse, colour, or titles.

**Premiere panel 0.11.0** adds `caption_track`, `encode` and `encode_cancel` (with their checks).

**MCP:** `create_captions`, `export_video` and `export_audio` are in `LONG_TOOLS` (15 minutes). A render longer than that, started from an outside client, would outlast the MCP call.

### Tests
**Python:**
- `test_resolve_render.py` (10) and `test_premiere_render.py` (7), ported;
- `tests/nle/test_renders.py`, ported;
- the 13h caption tests in `test_resolve_edit.py` and `test_premiere_edit.py`.

**TS:**
- `deliverTools.test.ts` (9): cues, both editors' captions, refusals, a render's progress and file, Stop cancelling it, failures;
- `tools.test.ts`;
- `bridge.test.ts`: the panel's new checks;
- `nle.rs`: the timeouts.

**Flaky (seen this phase):** `test_mcp_server.py`'s `test_outside_callers_are_refused_while_outside_control_is_off` and `test_a_call_held_for_review_outlasts_its_usual_limit` failed together once in three full runs and passed 6 of 6 on their own. They're timing-sensitive under load, and likely the unidentified flake noted under 12a.

### Checked live in Resolve (2026-10-09, Resolve Studio 21.1, "VibeCut 7a")
**Setup:** the Phase 14 harness: the app's own tools against a real `resolve-watch`. The test media was "VCA15_talk.mov", testsrc2 with speech from macOS `say` (8.6 s).

**15a:** `create_captions` (english, 42 characters, 1 line) made 5 subtitles on ST1 in about 2.5 s, with the words right ("We opened the bakery in 1999." … "and for the people."). Revert removed them and the track.

**15b:**
- 720p over 0–4 s gave 1280x720 H.264 with AAC, 4.07 s long.
- WAV gave 24-bit 48 kHz stereo, 8.6 s.
- AAC gave a `.m4a`.
- Stop cancelled a ProRes render and left no partial file.

**Found and fixed: an audio-only job broke later video renders.** VibeCut's AAC render set `ExportVideo: False`.
- **What happened:** after it, Resolve 21.1 rendered every later job without picture, even ProRes, and even jobs whose `GetRenderJobList` read `IsExportVideo: True` and `H.264`. Saving and loading the Deliver preset didn't clear it, and it changed the scratch project's Deliver page to video off with an `APVYUV422_10` codec. Loading Resolve's own "H.264 Master" preset cleared it.
- **The fix** (`resolve_render.py`):
  - AAC now comes out of a small H.264 carrier (640 px wide) copied to `.m4a` by ffmpeg, as WAV does, so video export is never switched off;
  - each job first loads `BASE_PRESET` ("H.264 Master"), so a Deliver page left on audio only by anyone can't make a picture-less render;
  - `StartRendering` is asked once more after 1 s when it refuses right after a render ended (seen once live: AAC straight after WAV; the same pair worked on the next run).
- **Checked live after the fix:** AAC, then 720p (with picture, 1280x720), then WAV, then Stop. The Deliver page was left video on, H.264.
- **Tests:** `test_aac_is_an_m4a_copied_out_of_a_small_h264_carrier` and `test_a_render_resolve_wont_start_at_once_is_asked_again`. The fake knows the built-in preset.

**Left as it is:** "VibeCut 7a"'s Deliver page is now Resolve's H.264 Master with its target folder at `~/Movies/VibeCut Renders/VibeCut 7a`. What it held before these runs isn't known, and the earlier VibeCut checks used the same folder.

**Cleanup:** the test timelines, their backups, the test clip and every "VCA 15 live" render file were deleted. 28 timelines remain, with "Timeline 28" current. The older Bakery renders in that folder were left alone.

### Checked live in Premiere (2026-10-09, Premiere 26.5.2, panel 0.11.0, "2026 Agent Tests")
**Setup:** the editor-side code through the real panel bridge, with no app. The scratch sequence "VCA 15 Premiere" (59.94 fps) held VCA15_talk.mov.

**Captions:** `create_captions` with the 5 cues Resolve had transcribed made an SRT in the bridge's `imports/`, and the panel made a caption track (count 5, 0.4 s). Revert reported "Premiere's scripting can't remove a caption track; delete it in Premiere", as designed.

**Renders through Media Encoder:**
- 720p over 0–4 s gave 1280x720 H.264 with AAC, 3.99 s long.
- WAV gave 16-bit 48 kHz, 8.56 s.
- Stopping a ProRes render answered "cancelled", left no partial file, and noted Media Encoder's paused queue.

**14d's Auto Reframe** made "VCA 15 Premiere (9x16)" with both clips, at **607x1080**: Premiere keeps the sequence's height. The tool's description promised 1080x1920; it now says what Premiere does, and so does `premiere_project.make_social_version`.

**Confirmed by the user's screenshot:**
- The 9x16 sequence has a subtitle track (C1) with the 5 lines at the right times; the reframed copy kept the captions.
- Its V1 clip carries Auto Reframe's fx.
- Media Encoder's queue keeps a cancelled job as "Stopped" (finished ones clear themselves). The user clears it there.

**Cleanup:**
- Both test sequences were deleted with the panel's `delete_sequence`, and the render files were deleted.
- **Left in "2026 Agent Tests":** the test clip and the SRT item in the "VibeCut" bin, which can't be deleted from a script.

## Phase 16a: The B-roll XML links in DaVinci Resolve (2026-10-10)

**Why (the user):** Resolve couldn't locate the files when they imported the Analyze tab's **Export XML…** with File › Import › Timeline. The XML had only ever been tried in Premiere.

**What the live repro showed** (scratch project "VibeCut 7a", two ffmpeg clips named `Shot #1 café.mov` with an embedded `14:03:22:00` and `Plain shot.mov` with none, imported with `MediaPool.ImportTimelineFromFile(..., {"importSourceClips": True})`):

| Variant | Resolve |
|---|---|
| A: the old export (every `<file>` timecode `00:00:00:00`, raw `file:///` paths, file definitions only in the bin) | import refused |
| B: A with percent-encoded `file://localhost/` paths | refused |
| D: A with the file definitions moved into the sequence | refused |
| C: A with only the real start timecode in the `<file>` | **linked**, all 9 items online |
| E: B + C + D | linked |

**The cause** is the start timecode. Camera files start at a time of day, and Resolve refuses the whole import when a clip's range lies before the file's first timecode. Raw paths with spaces, `#` and accents were fine.

**The fix** is in `broll/xml_export.py`:
- **`start_timecodes(results, probe)`** reads each source once with `ffprobe_util.probe_start_timecode`, the same probe the rebuilds use. `export_xml(..., timecodes=)` writes it into each `<file>`'s `<timecode>`: the string as the file has it (a `;` gives `DF`), and the frame at the file's own rate.
- Clipitem `<in>`/`<out>` stay counted from the media's first frame, as xmeml (and Premiere) read them. `export_xml` itself still opens no files.
- A file whose start can't be read keeps zero, and the result's `warnings` names it. `broll-export`'s result gains `warnings`, and the Analyze tab appends them to its notice. `broll-analyze` with `exportXmlPath` adds them to its own `warnings`.
- **Paths:** `<pathurl>` is now `file://localhost/` plus the NFC, percent-encoded path, as Premiere's own exports write it. Resolve didn't need it, but a `%` in a name now reads back exactly.
- The file definitions stay in the bin. Moving them made no difference to Resolve, and it keeps the layout Premiere has read since Phase 10.
- **Labels:** the save dialog is "Export XML for Premiere or Resolve". The notice says "Premiere: File → Import. Resolve: File → Import → Timeline.", and the button's tooltip says the same.

**Tests:** `test_xml_export.py` › `TestResolveLinking` covers the encoded path, the start timecode with relative in/out, drop-frame, and one probe per source with the unreadable ones named. `test_commands_export.py` covers the probed timecodes and the warning in `broll-export`'s result. `broll.test.ts` covers the new label and the warnings. All suites are green.

**Checked live in Resolve (2026-10-10):** the fixed `broll-export` ("VCA 16a F fixed") imported with every item online and the right source frames (left offsets 50, 150 and 25 at 25 fps for segments at 2 s, 6 s and 1 s). It was checked both with the clips already in the pool and from an empty pool.

**Cleanup:** the "VCA 16a" timelines and test clips were deleted, "Timeline 28" is current, and the test media was deleted.

**Pending:** the XML in Premiere, which reads the same timecode block (the user's try), and `npm run install-app`.

## Phase 16b: Names and colours for clips on a timeline (2026-10-10)

**Why (the user):** they picked four next features: clip colours and names, speed ramps, a Story Editor music bed, and the agent driving the Analyzer. Colour and names for timeline clips had been left for later in Phase 12, pending a probe.

**Probe (Resolve 21.1, scratch "VCA 16 probe"):**
- `TimelineItem.SetName` works, and a picture clip's linked sound takes the new name too. It even takes `""`, so empty names are refused before the call.
- `SetClipColor` takes one of the 16 clip colours, and an unknown one returns False. The colour is the item's own: neither the linked sound nor the Media Pool clip changes. `ClearClipColor` clears it.
- Ids stay the same.

**What was built:**
- **`label_timeline_clips`** (agent tool) sends `label_clips`: `{labels: [{itemId, name?, color?}]}`, up to 200, each giving a name, a colour or both.
- It's a direct edit, so it's backed up, in the edit log, revertible and reviewed under Review edits first ("Name or colour"). The change kind is `"label"`, with `{name, color}` before and after.
- The request check is shared by both editors: `nle/labels.py` (`label_wants`), standard library only.
- **Resolve** (`resolve_edit.label_clips`): colours are Resolve's clip colours, and "None" clears one. The change keeps the linked clips' old names (`partners`), so Revert gives them back too. Revert leaves a clip whose name or colour changed since. Transitions and generators are refused. `read_timeline` gives each clip's `color`.
- **Premiere** (`premiere_edit.label_clips`, panel **0.12.0**): `set_items` sets a track item's `name` and `setColorLabel(index)`, and the clip read gives `label` from `getColorLabel()`.
  - The 16 label colours (`PREMIERE_LABEL_COLORS`) can be changed but not cleared, and only the named clip changes.
  - Where Premiere's scripting has no track item labels (or an older panel), the colour is refused up front, and the panel refuses the whole call before changing anything. Whether 26.5.2 has `TrackItem.setColorLabel` is the open question for the user's try.
- **The snapshot** shows `colour Teal` on a clip.

**Tests:**
- Resolve and Premiere fakes cover label then revert (the linked sound's name included), a clear, "changed since", bad requests, transitions, and a Premiere without labels.
- `editTools.test.ts` covers the request and the summary; `snapshot.test.ts` covers the colour.

**Checked live in Resolve (2026-10-10)**, through a real `resolve-watch` on "VCA 16 probe":
- Renaming the picture clip renamed its sound, and Teal and Pink read back.
- "None" cleared the colour.
- Reverting three changes newest first gave back the names and no colour, read back the same.

**Pending:** Premiere, after Settings → Editors → Update panel (0.12.0) and a restart.

## Phase 16c: Speed ramps (2026-10-10)

**Probe (Resolve 21.1):** Resolve's scripting sets only one constant speed per clip (`SetSpeed`, `SpeedOptions`); it has no keyframed retime.
- An xmeml clip with a variable **Time Remap** (`graphdict` keyframes) imports as a smooth ramp. Stills at timeline frames 10/25/60/75/100/140 matched source frames 9/24/54/62/74/94, against an expected 10/25/55/62.5/75/95 (a steady one-frame offset).
- So a smooth ramp would need the Resolve rebuild to import xmeml instead of OTIO. That's left as a possible upgrade.

**What was built:** the draft already had VibeCut's ramp (`setDraftSpeedRamp`, Phase 8b there), and the rebuilds already send a ramp as consecutive pieces at constant speeds (`interchange/time_remap.speed_pieces`). Neither was offered to the agent. Now, in `timingTools.ts`, from VibeCut's `hostSpeed.ts`:
- **`set_speed_ramp`** `{clipId, changes: [{sourceTime?, speed}], easeSeconds?, ripple?}`: "from this source time on, play at this speed" (0.05–20, up to 50 changes, ease 0–30 s), with the clip's linked clips.
  - It works in the draft (opened if needed), and `send_to_*` builds it.
  - It isn't reviewed by itself; the send is.
- **`clear_clip_speed`**: back to 1×. It works in the draft when one is open; otherwise it's a direct `set_clip_speed` at 1 (reviewed).
- `set_clip_speed`'s description points to the ramp, and the prompt names both.

**Tests:** `timingTools.test.ts` covers a ramp (2 s at 1×, then 0.5×: a 6 s clip, the next clip rippled 2 s, and the linked sound ramped too), the refusals, and clear in and out of a draft.

**Checked live in Resolve (2026-10-10)** with the scratch Vitest harness: the app's real `set_speed_ramp` and `sendDraft` against a real `resolve-watch`, on "VCA 16 probe" (a 10 s clip).
- A ramp to 0.5× from 2 s and back to 1× from 4 s made "VCA 16c ramp", 12.0 s long.
- Picture and sound were each three pieces: 0–2 s at 1×, source 2–4 s over 2–6 s at 0.5×, and 6–12 s at 1×.
- The original timeline was unchanged.
- An eased ramp makes about 20 pieces for a 0.5 s ease.
- Cleanup: the "VCA 16" timelines and the probe clip were deleted, and "Timeline 28" is current.

**Pending:** Premiere (its rebuild places the pieces from the project's own clips; a ramp comes in as XML, as the draft's description says), for the user's try.

## Phase 16d: A music bed under a Story Editor cut (2026-10-10)

**Why:** 6d left out VibeCut's music bed, and the user picked it now.

**What was built** (after VibeCut's `storyEditorActions.ts` and `musicActions.ts`):
- **`run_story_editor`** takes three new arguments:
  - **`music`**: a clip on the timeline, a project clip or an absolute path.
  - `musicLevelDb`: −40 to 0, default **−18**, under the voices.
  - `snapToBeats`: default true.
- **Flow** (`lib/agent/musicBed.ts`):
  1. The music's beats and length come from the `media-beats` job (Phase 13d, up to its first 20 minutes). This runs *before* the Story Editor, so a missing or unreadable file costs no model call.
  2. With a steady pulse (confidence ≥ 0.3), the cut's main edit points snap to the nearest beat within 0.15 s. This is VibeCut's `snapPlanToBeats`, ported verbatim (`src/vibecut/lib/musicSync.ts` and its tests). A segment's length never changes, and nothing can overlap.
  3. The music goes on a new audio track of the draft from 0, trimmed to the cut (no stretching or looping), at the bed level.
  4. The summary and result say the track, level, BPM, how many cuts moved, and whether the music ends early.
- **Differences from VibeCut:**
  - The first main cut is never moved. Snapping it to a first beat a frame in left black at the head (seen live).
  - The fade-out isn't in the draft, because OTIO carries fades only as metadata. The summary and prompt tell the agent to `set_clip_fade` the music's end after sending.

**Tests:**
- `musicSync.test.ts` (VibeCut's 7).
- `storyTools.test.ts`:
  - the bed, the snap and the first cut kept;
  - the beats read before `assemble`;
  - no steady beat;
  - music shorter than the cut;
  - an unreadable file stopping before the Story Editor.

**Checked live in Resolve (2026-10-10)** with the scratch harness:
- **Setup:** a real `media-beats` run on a generated 120 BPM track, a real `resolve-watch` and the real `sendDraft`, on "VCA 16d probe". The Story Editor's model answer was canned, to spare a model call.
- **Result:**
  - The track read as 120.3 BPM (confidence 0.92).
  - "VCA 16d story 2" had the cut at 0–3.4 s and 3.48–7.48 s (the second moved onto a beat) on V1/A1, and the music on A2, 0–7.48 s at −18 dB.
  - The first run had moved the first cut to 0.04 s, which led to the first-cut rule.
- **Cleanup:** the "VCA 16d" timelines and the test clips were deleted, and "Timeline 28" is current.

## Phase 16e: The agent drives the Analyzer (2026-10-10)

**What was built** (`lib/agent/analyzerTools.ts`, after VibeCut's `analyze_broll`): three tools that use the Analyze tab's own code and store, so the tab shows the agent's run, options and selects. The user can untick segments there before the agent exports or builds.
- **`analyze_broll_folder`** `{folder?, contentAware?, brief?, dedupe?, segmentsPerClip?, segmentSeconds?}`:
  - It runs `broll-analyze`, with the request built by the tab's new shared `analysisRequest`.
  - The chat's Stop cancels it (`cancelOnStop`, now exported from storyTools).
  - It keeps the result in the tab (`keepResult`) and lists the best 15 clips with their segments.
  - Content-aware scoring (a 2 GB model on first use) is on only when asked, and the description says to ask the user. A brief or dedupe without it is reported as unused.
- **`export_broll_selects`** `{include?, best?, minScore?, order?, sequenceName?, outputPath?}` writes `broll-export`'s XML: Phase 16a's, for both editors.
  - It writes to `outputPath`, or the user picks a place in the save dialog. `exportSelectsXml` gained a `savePath`.
  - It isn't reviewed, since it doesn't touch the editor.
- **`build_broll_selects_timeline`** (selection arguments as above) is the tab's `buildSelectsTimeline`: a new timeline, one Revert. It's reviewed under Review edits first.
- The selection arguments set the tab's own options. `currentSelects()` (in `lib/broll.ts`) is the tab's selection, with near-duplicates left out.
- The MCP bridge counts `analyze_broll_folder` and `build_broll_selects_timeline` as long tools (15 min).

**Found and fixed: Build timeline laid segments a frame early** (Phase 10's, seen live here).
- Segment lengths that aren't whole frames (e.g. 2.2333 s) made Resolve round a placement onto the clip before it, so `add_clips` put it on V2.
- `timelineLayout(clips, fps)` now puts each segment on whole frames of the new timeline, each starting on the frame the last one ends. `buildSelectsTimeline` reads the new timeline's rate.

**Tests:**
- `analyzerTools.test.ts`: the request and options, the tab's kept result, the listing, a failed run, export by path, through the dialog and when cancelled, and nothing to export yet.
- `brollSelects.test.ts`: the frame layout.

**Checked live in Resolve (2026-10-10)** with the scratch harness:
- **Setup:** the real `broll-analyze` and `broll-export` (as Rust runs them) and a real `resolve-watch`, on three generated clips.
- **Result:**
  - The analysis ranked sharp (65.8) > soft (54.9) > dark (45.4).
  - The export of the best 2 wrote 4 segments with encoded `file://localhost/` paths.
  - The build made "VCA 16e selects 2" with all 4 segments back to back on V1/A1 (0–2.44–4.68–7.12–9.56 s). The first build, before the fix, had put the last one on V2.
- **Cleanup:** the "VCA 16e" timelines, their backups and the test clips were deleted, and "Timeline 28" is current.

## Phase 16f: Scale and position, still or keyframed (2026-10-22)

**Why (the user):** the agent told them it couldn't complete a prompt because it couldn't set scale or position in Premiere. They asked for still and animated looks, in both Premiere and Resolve.

**What was built:**
- **`set_clip_transform`** (agent tool) sends `set_clip_transform`: `{transforms: [{itemId, scale?, x?, y?} | {itemId, keyframes: [{at, scale?, x?, y?}]}]}`, up to 50 clips and 2 to 30 keys each.
  - Units are the same in both editors (`nle/transforms.py`, standard library only): scale in percent (100 is the clip as placed), x and y in the timeline's pixels from the frame's centre, x to the right and y up. `at` is seconds from the clip's start, and every key gives the same fields. Fields left out keep the clip's current value.
  - It's a direct edit: backed up, in the edit log, revertible and reviewed under Review edits first ("Scale or move"). The change kind is `"transform"`. `before` and `after` are looks (`{scale, x, y}` or `{keys}`) for the chat, and `motion` (Premiere) or `state` (Resolve) holds the editor's own values for Revert. Revert leaves a clip whose transform changed since.
- **`get_clip_transform`** (read only, not reviewed) sends `read_clip_transforms` `{itemIds}` and answers each picture clip's look in the same units.
- **Premiere** (`premiere_transform.py`, panel **0.13.0**): the panel's new `read_motion` and `set_motion` (`host.jsx`) read and replace the Motion effect's Scale (percent) and Position (`[x, y]` fractions of the sequence frame, y down). They clear and set keys as `set_fades` does, at source times.
  - A still value replaces that property's keys; the other property keeps its own.
  - Refused: sound clips, the scale of a clip with Uniform Scale off, keys on a clip with a speed change, keys past the clip's end, and two keys on one frame.
  - The sequence's frame size comes from `read_sequence` (`frameWidth`/`frameHeight`, Phase 14d).
- **Resolve** (`resolve_transform.py`): a still look is the Inspector's ZoomX/ZoomY, Pan and Tilt (`SetProperties`, read back).
  - Resolve can't keyframe the Inspector from a script, so an animation is a Fusion composition named **"VibeCut Move"**: MediaIn1 → Transform (`VibeCutMove`, Size and Center keyed) → MediaOut1, keys at the comp's `COMPN_RenderStart` plus the clip frame. The Inspector goes back to 100% at the centre so the move is the whole look.
  - Every key is read back. If Resolve didn't take them, the comp is removed, the Inspector put back and the clip refused.
  - A still look on a clip with VibeCut's move replaces the move, and Revert rebuilds it.
  - Refused: sound, transitions and generators; keys on a clip with its own Fusion comp or a speed change; scale (and keys) where Zoom X and Y differ.

**Tests:**
- Premiere and Resolve fakes (`test_premiere_transform.py`, `test_resolve_transform.py`) cover still and keyed looks with revert, fields left out, a still look replacing keys or a move, refusals, the editor not taking it, "changed since", reads and bad requests.
- The Resolve fake has a Fusion comp (`FusionComp`, `FusionTool` in `test_resolve_edit.py`) with comps starting at frame 0 and 1000.
- `bridge.test.ts` covers the panel's checks of `read_motion` and `set_motion`; `editTools.test.ts` the request and the summaries.

**Checked live in Premiere (2026-10-22, Premiere 26.5.2, panel 0.13.0)**, on a scratch "VCA 16f probe" sequence (1920×1080, 59.94 fps, deleted afterwards). The calls went through `PremiereHost` and the real bridge.
- Motion's display names are "Scale", "Position" and "Uniform Scale" (true). Position reads and sets as `[x, y]` fractions, with y down.
- A still 120% at (96, −54) read back as Scale 120 and Position [0.55, 0.55]. Revert gave back 100 and [0.5, 0.5].
- Keys at 0 s and 5 s (100%→130%, x −192→+192) landed at source ticks, Position at [0.4, 0.5]→[0.6, 0.5]. `get_clip_transform` read them back; 5 s snapped to 5.005 s, the nearest frame at 59.94. Revert cleared the keys.
- With keys set, `getValue()` still answers the un-keyed value; the module reads the keys instead.
- Not looked at: how the move looks on screen, or the keys' interpolation (Premiere's default for scripted keys).

**Checked live in Resolve (2026-10-26, Resolve Studio 21.1, "VCA 18 probe", 1920×1080, 25 fps)**, over MCP, each look checked in a render (stills from the Color page don't show the Inspector or Fusion, so the timeline was rendered to H.264 and frames pulled with ffmpeg).
- **The open questions, answered:**
  - Pan is +right and Tilt +up, in the timeline's pixels: 120% at (96, −54) rendered 1.2× larger, about 97 px right and 52 px down.
  - A timeline clip's comp starts at `COMPN_RenderStart` (0, the clip's first frame; `COMPN_GlobalStart` is minus the clip's source in).
  - `SetInput("Center", {1: x, 2: y}, frame)` keys an XYPath (its X and Y BezierSplines get the keys).
  - MediaIn delivers the clip at the timeline's resolution (1920×1080), and Center fractions match pixels: (−192, 0) → (192, 108) rendered as 192 px left, then 192 px right and about 111 px up.
  - Scripted keys are linear (`Flags = { Linear = true }` in the saved comp), as in Premiere.
- **Three fixes, all in `resolve_transform.py`:**
  - **The read-back:** `Transform.GetKeyFrames()` answers the tool's valid range (`{1: -125, 2: 625}`), not its keys, so every keyed move was read at the wrong frames and refused ("Resolve didn't take the scale or position"). The keys are now read from the comp's BezierSplines (`comp.GetToolList(False, "BezierSpline")`).
  - **Removing a move:** `DeleteFusionCompByName` answers False for the clip's active comp, and a clip's only comp is always active, so a refused move was left on the clip and Revert couldn't take one off. A move is now removed by deleting the Transform and wiring MediaIn1 to MediaOut1. The pass-through "VibeCut Move" left behind counts as no move and is reused by the next one.
  - **Rendering:** a comp changed by script calls renders as it was before them (it reads back and exports changed, and the Fusion page shows it, but the Edit page and a render don't). After each change the comp is now exported and imported again (`_reload`), which Resolve renders. The import replaced the clip's only comp in place.
- **Then, on the reinstalled app, on a fresh "Move probe" timeline:** a keyed move on camA and a still look on camB in one call rendered as asked; a still 110% replacing the move rendered still at every frame; a move plus a still look, reverted as one step, rendered at 100% in the centre, and the clip stayed.
- The fakes (`test_resolve_edit.py`) now behave as 21.1 did: the Transform's range from `GetKeyFrames`, splines in `GetToolList`, no deleting the active comp, and a comp rendering as it was when added or imported.

## Phase 17: Gemini (subscription), through the Antigravity CLI (2026-10-17)

**Why (the user, 2026-10-17):** use Gemini with the user's signed-in Antigravity CLI (`agy`, 1.2.1 at `~/.local/bin/agy`) instead of a Gemini API key, the way Phase 7b runs `claude -p` on the Claude subscription. The step-0 checks below were run live first, with the user's go-ahead. What was built is under "What was built".

**What was built:**
- **Choices** (`types/agent.ts`): "Gemini 4 Argon (subscription)" and "Gemini 3.8 Flash (subscription)" (`chatProvider: "antigravity"`; models `gemini-4-argon`, `gemini-3.8-flash`).
  - Settings → Agent model gains "Gemini (subscription) effort" (low, medium or high; remembered as `antigravityEffort`). It picks agy's `-low`/`-medium`/`-high` variant, and Claude's xhigh and max count as high.
  - A family the account doesn't offer (from `agy models`) is shown as "not on your plan".
- **Python:**
  - `agent/antigravity_chat.py` runs a chat turn. `agent/antigravity_json.py` gives one `--json-schema` answer (`structured_output`), used for chat titles and the Story Editor; its first pass runs on `gemini-3.8-flash`.
  - `chat.py`, `titles.py`, `story/commands.py` and `story/models.py` (`antigravity_json_answer`, `antigravity_story`) route `"antigravity"`.
  - The critic refuses it: its job is the stills, and agy takes text only. The message points to Settings → Edit review critic → Gemini Flash.
- **How a run is locked down:**
  - Each run writes its own agent, `<app data>/antigravity/.agents/agents/vibecut-<id>.md` (`tools: [finish]`; its body is the system instruction), and removes it afterwards.
  - The run must start on that agent (`init.agent`), and any tool step that isn't `mcp_vibecut_*` or `finish` stops it. That includes the MCP servers the user added to agy themselves.
  - A JSON run has no caller tag, and any tool step stops it.
  - Google keys (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, ADC, Vertex) are dropped from agy's environment. agy is signalled SIGINT, then SIGTERM, then SIGKILL on Stop.
  - The step limit counts tool steps. A sign-in prompt on stderr stops the run at once with "isn't signed in". Images are refused.
- **History:** the app's own, `[{role: "user"|"model", text, tools?}]`, two entries a turn. It goes in with each message as `<earlier_conversation>` (newest first, up to 60,000 characters). Retry and Edit cut it like the API providers' histories (`rewind.ts`, unchanged).
- **Rust:**
  - `antigravity.rs` (commands above).
  - `sidecar::prepare_request`'s last argument is now any subscription's setup, injected as `claudeCode` or `antigravity` by provider. Both names are dropped from what the webview sends.
  - `setup_for` refuses when VibeCut's tools aren't added, or are an older build's.
- **UI:** Settings → Accounts → Gemini subscription (`AntigravitySection`): status, program, the plan's Gemini models, and Add/Update/Remove for VibeCut's tools. About gains an "Antigravity (Gemini subscription)" row; availability, the chat-history labels and the controller's provider labels know the new provider.
- **Tests:**
  - `tests/agent/test_antigravity_chat.py` (18, against a fake `agy` replaying 1.2.1's events).
  - Title, critic and Story Editor routing tests.
  - `antigravity.rs` tests and a `prepare_request` test.
  - `AntigravitySection.test.tsx`, plus availability, controller-effort and persisted-state cases.
- **Checked live (2026-10-17), on the real agy, through `antigravity_chat` and `antigravity_json`, with no MCP server registered:**
  - Two turns: the second answered from the first ("marigold"), so the app's history fixes the resume problem below.
  - The agent's system prompt applied on both turns.
  - No agent file was left behind.
  - A title came back as `structured_output`.
  - About 11k prompt tokens a turn on VibeCut's agent, against about 20.7k on agy's default agent.
- **Not checked live yet:** a turn that calls VibeCut's tools through the real shim with the app running, after Settings → Add. Nor how long agy lets one MCP tool call run (a reviewed edit can wait up to 30 min).

**Step-0 checks (before building):**

**What `agy -p` offers:**
- `--input-format stream-json` (needs `--output-format stream-json`), `--model`, `--effort`, `--conversation <id>`, `--agent <name>` and `--print-timeout`.
- **Models:** `agy models` lists only Gemini 3.8 Flash (`gemini-3.8-flash-{low,medium,high}`) among the Gemini models; there is no Pro. It also lists Claude 5.5 and GPT-OSS, which this phase leaves out.
- **No equivalents for:** `--mcp-config`/`--strict-mcp-config`, `--tools`/`--allowedTools`, `--system-prompt`, `--max-turns`, `--fork-session` and `auth status --json`.

**Checked live (2026-10-17):**
- **Config isolation, no:**
  - `HOME=<scratch>` does move agy's config (`<scratch>/.gemini/config/`), but it also signs agy out.
  - Linking `~/.gemini/oauth_creds.json`, `google_accounts.json` and `jetski-standalone-oauth-token` doesn't sign it back in. The sign-in lives somewhere else, which wasn't looked for (Claude Code's auto mode blocked it as credential exploration).
  - So VibeCut runs agy under the real home.
- **Signed out:** a run waits for a browser login until `--print-timeout`, then ends with `result.status: "ERROR"`, `error: "authentication failed or timed out"`. The exit code isn't reliable (0 once, 1 once), so read `result.status`. Always pass a short `--print-timeout`.
- **Caller tag, yes:** a stdio MCP server inherits agy's environment. `VIBECUT_MCP_CALLER=<jobId>` on the `agy` process reached a stub server at its start and on its call, with no `env` in `mcp_config.json`.
- **MCP tools:** they are named `mcp_<server>_<tool>`. In `-p` they ran with no permission prompt.
- **Workspace agents, yes:** agy reads `<cwd>/.agents/agents/<name>.md` (also `.agent/agents/`; not `.gemini/agents` or `.antigravity/agents`). `agy agents` doesn't list them, but `--agent <name>` finds them. An unknown name exits 1 before any model call.
  - The body is the system prompt (a tag it asked for came back on the first turn).
- **Tool lockdown, yes:**
  - The frontmatter `tools:` takes built-in names only: `mcp_…` and `call_mcp_tool` are refused ("not found in registry").
  - With `tools: [finish]`, the agent had no shell or file tool: it reported `ls /` and a file read as unavailable and tried neither. MCP tools stayed available.
  - `init.tools` still lists all 60 built-ins, so the lockdown can't be confirmed from the stream.
  - Every MCP server in the user's global config reaches the agent, not just VibeCut's.
- **stream-json events:**
  - `init` `{conversation_id, init: {model, cwd, agent?, tools, permission_mode}}`.
  - `step_update` `{step_index, state: ACTIVE|DONE, step_type: user_input|agent_response|tool|system_message|error_message|finish, text_delta?, tool_name?, tool_info: {name, output?}, usage?}`.
  - `result` `{conversation_id, status: SUCCESS|ERROR, response, error?, num_turns, usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens}}`.
  - No rate-limit events were seen.
- **Resume, unreliable:**
  - `--conversation <id>` adds to the same conversation: the step index carries on and `num_turns` grows. But the model didn't see the earlier turn ("No code word has been mentioned"), with or without `--agent`. The resumed turn also dropped the agent's tag.
  - So the app would keep the history itself (as `gemini_chat.py` does) and send it with each turn.
- **Cost:** about 20.7k input tokens per turn even for "pong" (agy's own prompt), mostly read from cache on later steps.
- **Checked during the build:**
  - **The stream-json input line** is `{"event": "user", "message": {"role": "user", "content": [{"type": "text", "text"}]}}`. It needs `-p=`, or `-p` takes the next flag as its prompt.
  - **Images:** content blocks of type `image` are refused ("only text").
  - **`--json-schema`:** the checked object is the result's `structured_output`, next to the prose `response`.
  - **SIGINT:** ends a run in about 0.4 s with `result.status: "ERROR"`, `error: "interrupted"`.
  - **`agy models`:** exits 1 in about 1.5 s when signed out ("Please sign in"). The list changes on Google's side: Gemini 4 Argon appeared during the day.

**Design changes from the step-0 plan (as built):**
- Each turn runs in its own empty work folder holding `.agents/agents/vibecut.md` (`tools: [finish]`; the body is VibeCut's system prompt). Nothing is written to `~/.gemini` for the agent.
- VibeCut's MCP shim still has to be in the user's global `mcp_config.json`, under a fixed name. Adding it is an explicit, confirmed step in Settings. The caller tag comes from the `agy` process's environment.
- The history is the app's own and is sent with each turn. Retry and edit work as on the API providers.

**Cleanup:** the stub server was removed (`agy mcp remove vcprobe`), and `~/.gemini/config/mcp_config.json` is `{"mcpServers": {}}` again. It was a 0-byte file before; agy treats both the same.

## Phase 18: Interview and podcast polish (2026-10-26)

**Why (the user):** asked what would make the agent a better editor. The roadmap picked from what the tools can't do yet, by value to interviews and podcasts:
- **18a:** `cut_by_speaker`, multicam by who's talking. Built.
- **18b:** `make_split_edit`, J/L cuts. Built.
- **18c:** `clean_dialogue`. Built; `fill_room_tone` left for later.
- **18d:** `add_lower_thirds`, from speaker names and the titles the user gives. Built.

Later phases on that roadmap:
- **19:** shot changes; `close_gaps`, `replace_clip` and `insert_clip`; colour and colour matching.
- **20:** client notes to edits; learning a style from a reference edit; pacing checks; YouTube packaging.
- **21:** an SFX and music library; offline media, relink and proxies.
- **Alongside any phase:** plan-then-execute with a checkpoint per step, workflow recipes, and an agent eval suite.

### 18a: `cut_by_speaker`
- **What it does:** takes synced angles, each on a video track of its own (as `sync_and_place` lays them), plus an optional `wideTrack`. Over each stretch it switches the talking person's angle on and the other angles off. This happens in the **draft**, so it reaches the editor only through `send_to_*` (like the other draft cuts, it's in `NOT_REVIEWED`).
  - Clips stay on their tracks, switched off, so the user can re-enable another angle by hand.
  - The sound, other video tracks (B-roll, titles) and anything outside `start`–`end` are left as they are.
- **Who's talking**, `by`:
  - **`loudness`** (the default when every angle has a `mic`): each mic's peaks (the `audio-peaks` job) at 10 samples/s, averaged over 0.5 s. The loudest mic above `thresholdDb` (−40) wins, and any other within 4 dB counts as talking too.
  - **`transcript`:** the lines heard on the timeline (`heardView`, now exported from `transcriptTools.ts`). A line counts for the angle that names its speaker, or, when an angle names no speakers, the angle whose mic file it came from.
- **Planning** (`planShots`, pure):
  - Cuts land `leadFrames` (4) before the words.
  - Two people talking at once go to the wide (else the current angle holds); a pause holds the current angle.
  - An angle with no switched-on clip at a moment is never chosen there.
  - Shots under `minShotSeconds` (2) fold into the shot before, or the one after when the shot before's angle has no picture there.
  - A shot held past `maxShotSeconds` (12) gets evenly spaced cutaways of `cutawaySeconds` (2.5). `cutaway` is `wide` (the default with a wide), `listener` (the angle of the shot before) or `none`.
  - Shots are snapped to frames.
- **Applying** (`applyShots`, pure): each angle's clips are cut only where its on/off state changes. A ramped clip is refused (`clear_clip_speed` first). Split pieces keep their `linkGroup`; `rebuildRequest` links only pieces cut at the same moment, so the sound stays one clip.
- **Files:** `src/lib/agent/multicamTools.ts` (new; `MULTICAM_INSTRUCTION` in the system prompt), registered in `tools.ts`, `toolKinds.ts` and `mcp_server.py`'s `LONG_TOOLS`.
- **Tests:** `multicamTools.test.ts` (13) covers who's talking from lines, mics and levels; holds, folding short shots, the lead, the wide, missing pictures and both kinds of cutaway; applying in and outside a range; and the tool end to end by loudness and by transcript, plus its refusals.
- **Checked live in Resolve (2026-10-26)**, through the MCP bridge on the scratch project "VCA 18 probe": synthetic 30 s media (camA, camB, a wide; two mics, A talking 0–8 s and 16–24 s with an "mm-hm" at 11 s, B 8–16 s and 24–30 s, 10% bleed and pink room noise each).
  - By loudness: four shots A, B, A, B; the "mm-hm" folded away; no wide (no real overlap); `send_to_resolve` built "Multicam probe (VibeCut 1)" with the off pieces disabled, the mics untouched and the pieces' source points right (`GetLeftOffset`; Resolve's own `GetSourceStartFrame` reads one frame low on one piece, its rounding, not ours).
  - **Fixed:** the cuts landed 0.12 s *after* each speaker started instead of 4 frames before. The mics' smoothing makes a short "both" stretch at every handoff; it held the lead and folded into the outgoing speaker's shot. A short overlap between two different speakers now goes to the incoming one (test: "gives a short overlap at a handoff to the incoming speaker"). Rechecked on the reinstalled app: the cuts land at 7.72, 15.72 and 23.72 s, 7 frames before each speaker (the overlap starts a little before the handoff, so 3 frames earlier than `leadFrames`), sent as "Multicam probe (VibeCut 2)" with source points right.
  - **By transcript, on real speech (2026-10-26):** two `say` voices (Daniel 0.5–7.4 s and 14.5–20.4 s, Samantha 8.5–13.1 s and 21.5–25.5 s), each on its own mic with the other at −20 dB and pink noise, transcribed with Whisper (`speakers: false`).
    - **Found:** Whisper transcribed the bleed too. Each mic's transcript had all four lines, so every line counted for both angles, and the cut was one 30 s shot on the wide.
    - **Fixed (`bleedGroups`, `keepLoudest`):** the same words at the same time on two files (time overlap at least half the shorter line, at least 60% of the shorter line's words shared) are one line heard twice. It's kept only on the file whose level (`audio-peaks`, averaged over the line) is highest. Two people really talking at once say different words, so they still go to the wide. The result notes "N line(s) heard on more than one mic kept on the loudest".
    - Rechecked live on the reinstalled app: A, B, A, B with cuts at 7.92, 14.00 and 20.80 s (5–6 frames before Whisper's line starts), the wide off, source points right.
    - Not solved: diarizing each mic on its own (`speakers: true`) names a different person "Speaker 1" on each mic. With one mic per person, pass `mic` and no `speakers`.
  - **Checked live in Premiere (2026-10-26, Premiere 26.5.2, panel 0.13.0, a scratch copy of an empty project, "VCA 18 probe"):** by loudness (cuts at 8, 14 and 21 s) and by transcript (7.92, 14.00, 20.80 s), then `send_to_premiere`: every angle piece and its on/off right, and the mics whole, after the two Premiere fixes in the Change Log (2026-10-26, "Phase 18 live pass in Premiere").

### 18b: `make_split_edit` (J and L cuts)
- **What it does:** at a picture cut (one shot ending and the next starting on a video track), **J** brings the next shot's sound in `seconds` early (default 0.5, snapped to frames) and **L** lets the shot's sound run on that long. On each audio track the sound being extended (incoming for J, outgoing for L) and the sound it meets are trimmed and extended together. A track without the sound being extended is left alone, so a J never just leaves a hole.
- **In the draft**, not live: neither editor can trim a clip's sound apart from its linked picture from a script without unlinking it (several edits and backups; Resolve's trim even replaces the clip). In the draft it is one change per edit, and `send_to_*` builds it.
  - In the new timeline the moved sound isn't linked to its picture: `rebuildRequest` links only pieces that start on the same frame.
- **Refused, per edit (the rest are made):** no picture cut there; not enough media past the edge (the file's length comes from `media-info`); running into another clip; a speed ramp; less than a frame.
- **Files:** `src/lib/agent/splitEditTools.ts` (`splitEdit` is pure; `SPLIT_EDIT_INSTRUCTION`), in `NOT_REVIEWED`. Tests: `splitEditTools.test.ts` (6).
- **Checked live in Resolve (2026-10-26):** two shots cut at 10 s (camA and camB from 5 s, picture and sound), a 1 s J, `send_to_resolve`: camA's sound ends at 9 s, camB's sound starts at 9 s from 4 s while its picture stays at 10 s from 5 s, in sync; camB's picture and sound aren't linked in the new timeline (as expected).
- **L, checked live in Resolve (2026-10-26):** the same two shots, a 1 s L at 10 s: camA's sound runs to 11 s, camB's sound starts at 11 s from 6 s under its picture (10 s from 5 s).
- **Checked live in Premiere (2026-10-26):** three shots cut at 10 and 20 s, a 1 s J at 10 and a 1 s L at 20 in one call, then `send_to_premiere`: camA's sound 0–9 s; camB's sound 9–21 s from 4 s under its picture (10–20 s from 5 s); camW's sound from 21 s from 6 s. The pictures were untouched (the sound-only pieces' picture went to a scratch track; see the Change Log).

### 18c: `clean_dialogue`
- **The sidecar command `media-clean`** (`media/clean.py`, in `headless.COMMANDS`, `sidecar.rs` and `SidecarCommand`): `{paths (1–16), strength}` → `{files: [{path, output, duration, reused} | {path, error}]}`.
  - Each file's first sound stream goes through ffmpeg:
    - light: `highpass=f=80,afftdn=nr=6:nf=-45:tn=1`
    - medium: `highpass=f=90,afftdn=nr=12:nf=-40:tn=1,deesser=i=0.3`
    - strong: `highpass=f=100,afftdn=nr=20:nf=-35:tn=1,deesser=i=0.5`
  - Output: `<name>.vca-clean-<strength>.wav` (24-bit, the source's rate and channels) beside the source, written as `.part` then renamed.
  - The whole file is cleaned, so source points carry over. A cleaned file newer than its source is reused. A read-only folder is refused with a hint.
- **The tool** (`src/lib/agent/dialogueTools.ts`): picture or sound clip ids. A picture means its linked sound, and the channel clips of one recording at one place are cleaned and laid once.
  - It runs `media-clean`, then `add_clips` with the cleaned file (sound only, same `at` and source points, the clip's level, on a free audio track) and `set_clips_enabled` false on the originals whose cleaned copy was placed.
  - One request means one backup and one Revert. It's reviewed ("Clean the dialogue of") and refused while a draft is open. Speed-changed clips are refused.
- **Tests:** `tests/media/test_clean.py` (4, real ffmpeg: same rate, channels and length; reuse until the source changes; a missing file reported) and `dialogueTools.test.ts` (5).
- **Checked live in Resolve (2026-10-26)** on the J-cut timeline above (sound clips at 0–9 s and 9–20 s, from 5 s and 4 s), medium: a picture id resolved to its linked sound; both cleaned WAVs went on a new A2 at the same places and source frames, the originals on A1 switched off; `revert_timeline_edits lastStep=true` removed A2's clips and switched A1 back on.
  - Levels on `micA.wav` (speech, bleed, pink noise): speech −29.8 dB before, −29.9 / −29.9 / −30.0 after (light / medium / strong); a stretch where only the other voice bleeds −45.9 dB before, −49.0 / −49.6 / −49.8 after. The synthetic mics have no pure room-tone stretch, so the floor itself wasn't measured; by ear on a real noisy interview is still to do.
  - Outside (MCP) calls under 2 minutes apart share one Revert step (Phase 7d), so `lastStep` also tried to undo the two earlier `add_clips` on other timelines; it reported them as failed ("Resolve didn't remove it", those timelines weren't open). As designed, but worth knowing when testing over MCP.
  - **Checked live in Premiere (2026-10-26)** with a stereo WAV (10 s of it from 2 s, laid as one stereo clip on A1): medium cleaned it to a stereo WAV laid as one clip on A2 at the same place and source points (2–12 s), the original switched off.
    - The first try put the cleaned copy a frame early (from 1.92 s against the original's 1.96 s, itself asked for at 2.00 s). Premiere places a file with no picture a frame early; fixed in `place_clip_exact` (Change Log, "Phase 18 live pass in Premiere").

### 18d probe: titles in Resolve (2026-10-26)
- `Timeline.InsertFusionTitleIntoTimeline("Text+")` puts a 5 s Text+ at the playhead, and its text can be set: `item.GetFusionCompByIndex(1)`, the `TextPlus` tool, `SetInput("StyledText", …)`.
- But it is a **ripple insert on V1**: over a clip it split it and pushed the rest later. It ignores an added V2, refuses (returns None) when V1 is locked, and a title can't be moved afterwards (no `SetStart`). So it can't place a lower third over a cut.
- **So 18d:** render each lower third with Pillow (this ffmpeg has no `drawtext`) and lay it with `add_clips` on a free track, in both editors, with one Revert. The text isn't live-editable in the editor; a MOGRT in Premiere can still be probed for that.

### 18d: `add_lower_thirds` (2026-10-26)
- **Media, probed live first:** a PNG still laid for 5 s works in both editors, but Premiere gives a still an hour-long source range (it read 3599.96–3604.96 s). So each lower third is a short **ProRes 4444 clip with alpha** instead: the source range is plain (0 to `seconds`), and the fade in and out is baked into the alpha. Resolve set its alpha mode to Straight by itself, and both editors composite it over the picture (checked in renders).
- **The sidecar command `media-titles`** (`media/titles.py`, in `headless.COMMANDS`, `sidecar.rs` and `SidecarCommand`): `{titles: [{name, title?}] (1–20), width, height, fps, seconds (1–30, default 5), fade (default 0.3 s, at most a third), look, accent, position, project}` → `{files: [{name, title, output, reused} | {name, error}], folder}`.
  - Pillow draws the frame-sized RGBA image: the name in Helvetica Neue Bold, the title under it in Regular (Helvetica, then Pillow's own font, as fallbacks), an accent rule on the left, and under them a dark panel (`bar`, the default) or a soft shadow (`clean`).
  - Sizes follow the frame's short side (name 5.8%, title 3.4%), so a 9:16 version is as readable as 16:9. The title-safe margin is 6% (8% vertical), and the bottom margin 11% (22% vertical, clear of an app's captions and buttons). A name too wide is shrunk to fit, and its title stays at most 60% of the name's size.
  - ffmpeg loops the image at the timeline's rate into `prores_ks` 4444 (`yuva444p10le`), written as a hidden `.part.mov` and then renamed.
  - Files go in `~/Movies/VibeCut Renders/<project>/Lower thirds/` (renders.py's folder), named "<name> - <title> <hash>". The hash covers the text and everything drawn, so asking for the same one again reuses it.
- **The tool** (`src/lib/agent/titleTools.ts`, `TITLE_INSTRUCTION` in the system prompt):
  - Each entry is `{name, title?, at? | speaker?}`.
    - `speaker` (a name from `list_speakers`) places it `SPEAKER_LEAD` (1 s) after that person's first line.
    - The lines go through `withoutBleed` first, so a mic's transcript of the other person's bleed doesn't place a title early. `withoutBleed` is now shared with `cut_by_speaker`, out of `multicamTools.ts`.
  - Each lower third is kept inside the timeline. Two that would overlap are refused, since they share one track.
  - The track is the one above the highest video track with any clip (`titleTrack`). When it doesn't exist yet, `add_track` adds it first, in the same request, so one Revert takes everything off.
  - It's laid with `add_clips` (picture only, source 0 to `seconds`), reviewed under Review edits first ("Add lower thirds (n)"), and refused while a draft is open. The MCP bridge counts it as a long tool.
  - Titles come from the user or the project notes: the description and the instruction tell the agent not to invent them.
- **Tests:** `tests/media/test_titles.py` (4: real Pillow and ffmpeg; ProRes 4444 with alpha at the asked rate and length, faded in from nothing, the bar where it should be and the top clear, reuse, a long vertical name kept in the safe area, bad requests) and `titleTools.test.ts` (7: placing by time and by speaker, keeping inside, overlaps, the track, the job and `add_clips` requests, a failed render, bleed dropped before placing by speaker, refusals, review).
- **Checked live (2026-10-26)** on the speech interview (camA V1, camB V2, the two talking mics, speakers named Daniel and Samantha), by speaker with titles:
  - **Premiere 26.5.2:** Daniel at 1.00 s and Samantha at 9.16 s (her own first line is at 8.16 s; the bleed copy at 0 s was dropped), on the free V3. An exported frame showed both composited with transparency. Revert took them off.
  - **Resolve 21.1**, look `clean`: the same places, on a V3 the tool added. A render showed them over the picture. Revert took them and the track off.

## Phase 19: Timeline edits, shot changes and colour (2026-10-26)

**Why (the user):** next on the Phase 18 roadmap. 19a first, as basic edits the other workflows lean on; then shot changes; colour and colour matching last (they need probes in both editors).

### 19a: `close_gaps`, `insert_clip` and `replace_clip`
- **All three are draft edits** (`src/lib/agent/draftEditTools.ts`, `DRAFT_EDIT_INSTRUCTION`): a ripple moves every later clip on every track, which neither editor does from a script in one edit (Premiere's insert moves only its targeted tracks; "7b.0 probe"). They open a draft if there isn't one, reach the editor only through `send_to_*`, and are in `NOT_REVIEWED` with the other draft cuts. The MCP bridge lists them from the same declarations.
- **`close_gaps`** `{minSeconds?, from?, to?}`: a gap is a stretch where **no** track has a clip (an off clip counts as one), the end of the timeline included. Each is ripple-deleted through `arrangeSections`, so every track moves together and sync holds. A stretch where only some tracks are empty (B-roll on V2) isn't a gap. Unlike `remove_time_ranges`, a marker in a gap is kept, moved to where the gap was.
- **`insert_clip`** `{path, sourceIn?, sourceOut, at, mode?: insert|overwrite, videoTrack?, audioTrack?, picture?, sound?}`: wraps the draft's existing `insertDraftClip` / `overwriteDraftClip` (Phase 7b), which had no tool. Insert cuts every track at `at` and moves the rest later. `EditOptions` gained `withPicture`, so a sound-only file (by its probed facts, else its extension) goes on audio alone. `sourceOut` past the file's end is refused (not for stills).
- **`replace_clip`** `{clipId, path, sourceIn?, keepLinked?}` (`replaceDraftClip`): a replace edit. The new file fills the clip's own place and length from `sourceIn`; nothing moves. Its linked picture or sound is replaced too unless `keepLinked`, and a linked part the new file lacks is taken out (the sound under a picture from a silent file). Each replaced clip keeps its track, on/off and level, and a split-stereo channel when the new file has it. The new clips have no `originId`, so no grade is copied in Resolve and Premiere's native send imports the file when the project hasn't got it.
- `draftGroup` in `hostDraft.ts` is now exported.
- **Tests:** `draftEditTools.test.ts` (13: gaps found and closed on every track with markers kept, partial-track stretches left, sound-only insert, picture-only overwrite, replace with and without linked sound, too-short and wrong-kind files, channels, and the three executors).
- **Stills are refused** by `insert_clip` and `replace_clip` (pointing to `add_clips` after the send). Seen live: a PNG in the draft made `send_to_resolve` fail ("still.png is only 0.04 s long, but a clip uses it up to 1.00 s": Resolve's Media Pool gives a still one frame), and Premiere gives stills an hour-long source range (18d).
- **Checked live (2026-10-26)** over MCP (a scratch script driving the shim), on synthetic media (`p19_camA/B/C.mov` with a 300/500/700 Hz tone each, `p19_silent.mov` with no sound, `p19_vo.wav` at 900 Hz, `p19_still.png`). The timeline: camA 2–6 s and camB 8–14 s (picture and sound linked), the silent clip on V2 at 9–10 s, markers at 7 s (in a gap) and 9 s. In one draft: `close_gaps` (2 gaps, 4 s; the gap's marker moved to 4 s), an insert of camC at 4 s, an insert of the WAV at 0 s on A2, camB replaced with camC from 10 s, camA's picture replaced with the silent clip keeping its sound, a picture-only overwrite on V2, then the send. Refused as they should be: the still, a WAV for a picture clip, a `sourceIn` too late, and a `sourceOut` past the WAV's end.
  - **Resolve 21.1** ("VCA 18 probe", "19a probe 4"): the new timeline read back clip for clip as the draft had it, both markers at 8 and 9 s.
  - **Premiere 26.5.2** (panel 0.13.0, "VCA 19 probe", a scratch copy of an empty project): the native send imported the new files and placed every piece where the draft had it. A render of the sound (`export_audio`) put the WAV at 0.00–2.00 s, camA's kept sound at 2.00–6.00 s and camC's at 6.00–14.00 s, measured in 10 ms windows: no frame offset.
  - **Seen on the way, outside 19a:**
    - Over MCP, the call right after `create_timeline` was once still checked against the previous timeline ("V1 isn't free from 2.0 s to 6.0 s" on an empty new one); a moment later the app had caught up. Each outside call takes the open timeline from the app's state, which a just-made timeline can lag. The in-app chat isn't affected (it carries the new timeline in its context). **Fixed:** `src/lib/mcp/server.ts` keeps the timeline an outside call moved to (`create_timeline`, `switch_timeline`, `duplicate_timeline`, a send, a rename) for the next outside calls until the watcher reports another open timeline, at most `MOVED_TIMELINE_MS` (30 s); a timeline the user opens meanwhile wins. Only the name counts, since a state for another reason (the grown list of timelines) can come first. Tests in `server.test.ts` (2). Checked live in Premiere: `add_clips` straight after `create_timeline`, twice, landed on the new sequence.
    - Once, right after importing three new files, Resolve refused to place one on a just-added V2 (`add_clips` reported "Resolve didn't place p19_silent.mov on V2"). Not seen again on the same files.
    - The send of a draft with a same-named file already in Resolve's Media Pool was refused by the existing guard (Resolve matches by name); renaming the probe files fixed it.

Later in Phase 19: shot changes (detecting cuts in a flattened file); colour and colour matching.

## Installing and Launching (2026-10-07)
- **`npm run install-app`** (`scripts/install-app.sh`, `zsh -l`):
  - checks for npm, cargo and uv, then runs `npx tauri build --bundles app`;
  - quits a running installed copy with a real Quit (an Apple Event, so `RunEvent::Exit` stops the sidecars);
  - signs with a lasting identity (`VIBECUT_SIGNING_IDENTITY`, else the first "Apple Development" one, passed as `APPLE_SIGNING_IDENTITY`). The designated requirement is then the bundle id plus that certificate, the same for every build, so the Keychain's "Always Allow" for the API keys survives updates. An ad-hoc signature changes every build and made the Keychain ask each time (seen live 2026-10-07). Tauri adds the hardened runtime, and the sidecar runs under it;
  - copies the bundle to `~/Applications/VibeCut Agent.app` with `ditto`;
  - opens it, unless a dev build (`target/debug/vibecut-agent`) is running.
- **Launch behaviour (`lib.rs`):**
  - The installed app opened by hand shows its window (`login_item::shows_window_at_launch`). A dev build, or a start with `--at-login`, stays in the menu bar.
  - `RunEvent::Reopen` (Spotlight, Launchpad or the Dock while it runs) calls `tray::show_main`.
- **Open at login:**
  - `tauri-plugin-autostart` 2.7 with `MacosLauncher::LaunchAgent` and the argument `--at-login`. Its plist goes in `~/Library/LaunchAgents`.
  - `login_item.rs` adds `open_at_login_status` / `set_open_at_login`. They are called from Rust only, so no JS capability is needed.
  - A debug build refuses (`DEV_BUILD_REFUSAL`), since its LaunchAgent would point at `target/debug`.
  - Settings → Window → "Open at login" (`LoginItemRow`), off by default.
- **Checked (2026-10-07):**
  - The script built and installed the app (ad-hoc signed, found by Spotlight) and opened it.
  - The bundle's sidecar, Resolve and Premiere watchers ran from `python-env` in the app data folder.
  - A second `open` kept one process.
  - Not yet: the Open at login toggle in the installed app.

## API Keys in the Keychain (2026-10-05)

**Decision (the user):** release builds take their keys from the **macOS Keychain** (option 1). A release app opened from Finder has no shell environment and no repo `.env`.

**`src-tauri/src/secrets.rs`:**
- **Lookup order:** the environment first (dev builds load the repo's `.env` into it), then the login Keychain: service `com.cj.vibecutagent`, account `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`.
- **Commands:** `llm_key_status` reports `{ gemini, anthropic, geminiSource, anthropicSource }`, with the source being `environment` or `keychain`; never a key. `llm_key_set(provider, key)` stores a key after `checked_key` (trimmed, one word, at most 512 characters). `llm_key_remove(provider)` deletes it.
- **Testing:** a `KeyStore` trait with a `Keychain` implementation (`keyring` 3, `apple-native`); tests use an in-memory store. `cargo test -- --ignored real_keychain` round-trips a throwaway item in the real Keychain.
- **Sidecar:** `sidecar_start` resolves keys through this lookup, and only for `chat`. The rest is unchanged: the key goes into the first stdin request, is stripped from anything the UI sends, and is redacted from errors.

**UI:**
- **Settings → API keys:** a write-only password field per provider (cleared right after Save), plus Remove for a Keychain key, and a note when the environment overrides the Keychain.
- **About:** says where each key comes from.
- **Missing-key hints:** they now point to Settings.

**Dev-build note:** macOS ties Keychain access to the app's code signature. After a rebuild, macOS may ask once to allow "VibeCut Agent" to use its own item; choose Always Allow.

## Handoff Notes
- The initial Vite/React/Tailwind setup has been scaffolded.
- Python env is initialized via `uv`.
- **Next, by value:**
  - **A live edit and revert pass** on a scratch timeline in each editor, recording what the editors actually do.
  - **Persist the edit log**, so Revert survives a restart.
  - **Transcripts** (VibeCut's interview-transcriber) for a real speech-based duck.
  - **Drafts and ripple edits**, from VibeCut's `hostDraft.ts`.
  - *(2026-10-06)* Transcripts, drafts, audio sync and the Story Editor are done (Phase 6a–6d). Next by value: the user's live try of the whole interview-to-edit flow in the chat; Premiere's live checks (panel 0.8.0); the Story Editor's music bed (VibeCut's beat sync); ducking carried into a Story Editor draft.
  - *(2026-10-06)* **Phase 7 (7a, 7b, 7d) is built and unit-tested**, and the 7b chain was checked end to end with real Claude Code and a stand-in app. Next: its live checks in Resolve and Premiere ("Phase 7" → Live checks), then the user's own try of a remote session from their phone.
  - *(2026-10-06)* **Claude Code profile:** the user signs VibeCut Agent in with their **Work** profile (`/Users/cj/.claude-profiles/Work`). No profile folder is saved in Settings yet (`claude-code.json` is absent), so the app runs Claude Code's default `~/.claude`. It's signed in to the same team account, but its sessions and settings are kept apart from Work's. Set Settings → Claude subscription → Profile folder to the Work folder. Earlier "Personal profile" checks (7b, 7e, 7f) ran in dev shells and stand for the same CLI behaviour.
  - *(2026-10-06)* **Phase 8a is built:** chats, the Claude Code session and the edit log survive a restart, with a History menu (⌘Y), and a gone Claude Code session falls back to a new one. Revert after a restart is checked live in Resolve. Next: the user's own try of the app across a quit and relaunch, Premiere, then Phase 7's live checks.
  - *(2026-10-06)* **Phases 8b–8d are built:** streaming replies on all three providers, Copy/Retry/Edit (Claude Code turns now fork their session), and History search, rename and model-written names (`chat-title`). Gemini and Claude API streaming checked live with the keys. Next: the user's own try (with 8a's), "Revert & retry" on a scratch Resolve timeline, then Premiere and Phase 7's live checks.
  - *(2026-10-06)* **Phases 8e–8h are built:** formatted replies with timeline-position chips, tool call cards, images with a message (all three providers; Claude Code now reads stream-json input), and saved prompts on `/`. Provider image turns checked live. Next: the user's own try in the app (8a–8h together), "Revert & retry" on a scratch Resolve timeline, then Premiere and Phase 7's live checks.
  - *(2026-10-07)* **Phase 9 is built:** effort per Claude model (medium by default), the usage tracker (plan limits from Claude Code plus tokens and cost), and the Mini Player (⌥⌘M). Phases 8e–8h are committed as `890e089`. Next: the user's own try of the Mini Player (drag, expand, over a full-screen editor) and the usage pill; replace the repo `.env` Anthropic key (401); then 8a–8h's in-app checks and Resolve's "Revert & retry".
  - *(2026-10-07)* **Phase 10 is built:** the Analyze tab's options are remembered, clips give up to 20 segments with ticks, segments preview in the app, and the selects export as a Premiere XML (`broll-export`) or build a new timeline (one Revert). Next: the user's try in the app (`npm run install-app` or `tauri dev`), Build timeline on a scratch Resolve timeline, and the XML in Premiere. The header layout was left for later.
  - *(2026-10-07)* **Phase 11 is built:** Settings in tabs (About keeps what only reports), a message queue, @-mentions, Review edits first (with `mcp_hold` for Claude Code), done notifications, and a faster first token (bytecode kept outside the bundle, lighter imports, a warm job and a warm Claude Code). Next: the user's try in the installed app (notifications ask once), a review card on a scratch Resolve timeline, and Gemini/Claude API timings with a fresh key.
  - *(2026-10-07)* **The app installs:** `npm run install-app` puts it in `~/Applications` (Spotlight, Launchpad, Dock), with Settings → Window → Open at login. Next: the user's try of Open at login, and keys in Settings → API keys for the installed app (it reads the Keychain, not `.env`).
  - *(2026-10-08)* **Phase 12 is built** (on `phase-8-persist-chats`, not pushed):
    - 12a: send_to_premiere is built inside Premiere, so no more imported copies;
    - 12b–12d: speed, transitions, tracks and track switches;
    - 12e: organizing the Media Pool / project.

    Next:
    - The user updates the Premiere panel to 0.9.0 (Settings → Editors → Update panel) and restarts Premiere, then tries a resequence and send.
    - ~~A live pass in Resolve~~: done 2026-10-09; every edit and its Revert held.
    - Later: colour and names for clips on a timeline (needs a probe), speed ramps.
  - *(2026-10-09)* **Phase 13 is built** ("an agent that sees, hears and remembers"): 13a–13d are built and committed: a sharper snapshot, `look_at_*` contact sheets, project notes (⌘⇧N), and loudness and beats. Checked live in Resolve and (13a's playhead and In/Out) in Premiere the same day. Next: the user's own try in the app.
  - *(2026-10-09)* **Phase 14 is built** (the user picked Review & QC, Social & music and a prompt pack; captions and renders are left for later):
    - 14a: `review_edit`, VibeCut's edit lint plus delivery checks;
    - 14b: the vision critic on all three providers;
    - 14c: `cut_to_beats`;
    - 14d: `make_social_version` (Premiere panel 0.10.0);
    - 14e: ten new saved prompts.

    14a, 14c and 14d were checked live in Resolve, and the critic with Gemini and Claude Code. Next: `npm run install-app` and the user's try; Premiere's Auto Reframe after a panel update. Later candidates: captions (SRT from the transcripts, onto a subtitle track) and renders (the Resolve render queue, Media Encoder).
  - *(2026-10-09)* **Phase 15a, a tidier Agent row:** the chat's name (opens History) on the left; `Revert N` and a New chat icon on the right; Review edits first is a shield in the composer. Next: the user's try after `npm run install-app`, then the next chat features.
  - *(2026-10-22)* **Phase 16f:** `set_clip_transform` and `get_clip_transform`: scale and position, still or keyframed, in both editors (Premiere panel 0.13.0; Resolve's animation is a "VibeCut Move" Fusion comp). Checked live in Premiere (panel 0.13.0). Next: the Resolve live check (see "Phase 16f" for the open questions).
  - *(2026-10-10)* **Phase 16e:** `analyze_broll_folder`, `export_broll_selects` and `build_broll_selects_timeline`; Build timeline now lays selects on whole frames. Checked live in Resolve. **Phase 16 (a–e) is done.** Next: `npm run install-app`, then the user's try; in Premiere, update the panel to 0.12.0 for clip colours, and try the 16a XML and a ramp.
  - *(2026-10-10)* **Phase 16d:** the Story Editor's music bed (`music`, `musicLevelDb`, `snapToBeats`). Checked live in Resolve. Next: 16e, the agent driving the Analyzer.
  - *(2026-10-10)* **Phase 16c:** `set_speed_ramp` and `clear_clip_speed` (the draft's ramp, sent as constant-speed pieces). Checked live in Resolve. Next: 16d the Story Editor music bed, 16e the agent driving the Analyzer.
  - *(2026-10-10)* **Phase 16b:** `label_timeline_clips` names and colours clips on the timeline (one Revert). Checked live in Resolve; Premiere needs panel 0.12.0. Next: 16c speed ramps (the draft's existing `setDraftSpeedRamp` as a tool), 16d the Story Editor music bed, 16e the agent driving the Analyzer.
  - *(2026-10-10)* **Phase 16a:** the Analyze tab's XML now imports in Resolve (File › Import › Timeline). It carries each source's real start timecode, which Resolve needs; checked live. Next: the XML in Premiere (the user's try), `npm run install-app`, then the next chat features.
  - *(2026-10-26)* **Phase 18a:** `cut_by_speaker` switches a multicam's angles by who's talking (loudest mic or transcript speakers), in the draft. Unit-tested; not checked live. Next: the live check in Resolve (see "Phase 18").
  - *(2026-10-26)* **Phases 18b and 18c:** `make_split_edit` (J/L cuts, in the draft) and `clean_dialogue` (ffmpeg cleanup beside the source, laid under the clip with the original switched off; the new sidecar command `media-clean`). Unit-tested; not checked live. Next: live checks of 18a–18c, then 18d lower thirds, which needs live probes (Resolve Text+ via `InsertFusionTitleIntoTimeline`, a bundled MOGRT in Premiere).
  - *(2026-10-26)* **Phase 18 live pass (Resolve):** 18a by loudness, 18b (J) and 18c checked live; `cut_by_speaker`'s lead fixed. Text+ can't be placed on a free track from a script, so 18d lays PNG lower thirds with `add_clips`. Next: Premiere checks of 18a–18c, `cut_by_speaker` by transcript on real speech, then 18d.
  - *(2026-10-26)* **The remaining live checks are done:** 18a by transcript (Resolve and Premiere), 18a–18c in Premiere, the L cut, and 16f in Resolve. Five fixes came out of them: mic bleed in `cut_by_speaker` by transcript; Resolve's Fusion moves (read-back, removal and rendering); and three in Premiere (`add_clips` with picture-only clips, `send_to_premiere` overwriting sound under picture-only pieces, and sound-only files placed a frame early). Next: 18d lower thirds (PNG with alpha through `add_clips`).
  - *(2026-10-26)* **Phase 18d is built and checked live in both editors:** `add_lower_thirds` (ProRes 4444 lower thirds from the new `media-titles` command, placed by time or by speaker, on a track above the picture, one Revert). **Phase 18 (a–d) is done.** Next: Phase 19 (shot changes; `close_gaps`, `replace_clip` and `insert_clip`; colour matching), or `fill_room_tone`, left over from 18c.
  - *(2026-10-26)* **Phase 19a is built:** `close_gaps`, `insert_clip` (insert or overwrite) and `replace_clip`, all in the draft. Unit-tested; not checked live. `main` was fast-forwarded to Phase 18d first, and 19 is on `phase-19-timeline-edits`. Next: live sends of 19a in both editors, then 19's shot changes.
  - *(2026-10-26)* **Phase 19a is checked live in Resolve and Premiere** (a render in Premiere for the WAV's timing). Stills are now refused by the draft edits. Next: 19's shot changes; maybe the MCP timeline lag after `create_timeline` (see "19a").
  - *(2026-10-26)* **The MCP timeline lag is fixed** (outside calls keep a timeline they just made or switched to until the watcher reports it). Next: 19b, shot changes.
- **Agent context:** each message reads the timeline fresh, so the agent re-syncs on every turn. `needsResync` can also invalidate any future cache.
- **Phase 4 key injection.** `prepare_request` in `sidecar.rs` only strips `apiKey` for now. When the chat agent lands:
  - Inject `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` into the request that needs it, following VibeCut's `prepare_request`.
  - Change `agentStatusForSession("ready")` to `idle`.

## Change Log
- **2026-10-05 (Claude): Phase 1 complete.**
  - Rust: renamed the crate (`temp` → `vibecut-agent` / `vibecut_agent_lib`) and split it into `lib.rs`, `commands.rs`, `state.rs` and `tray.rs`.
  - The app launches hidden as a menu-bar-only app (macOS `ActivationPolicy::Accessory`, so there is no Dock icon). Closing the window hides it.
  - Tray menu: Open Agent Panel, Open B-Roll Analyzer, Settings…, About This App, Quit.
  - Frontend:
    - Stores: `useAgentStore`, `useNleStateStore`, `useUiStore`, `useSystemStore`.
    - Chat and B-Roll tabs, with ⌘1, ⌘2, ⌘, and ⌘I shortcuts.
    - Accessible `Modal`, a Settings panel (model, key status, preferred editor, dependencies) and an AGENTS.md §7 About modal.
  - Tooling: ESLint 9 flat config (`npm run lint`); jest-dom registered for Vitest; a restrictive CSP replaces `csp: null`.
  - Deviation: the stack stays on Vite 8, not the Vite 7 in AGENTS.md §2, to match the original VibeCut repo.
  - The chat composer is disabled while the agent is `offline`. No LLM or NLE traffic exists yet.
  - Port sources for Phase 4: VibeCut `src-host-panel/` (App.tsx, Broll.tsx, usePanel.ts) is already decoupled from the editor stores. Don't port `src/components/ai/ChatPanel.tsx`; it's tied to the timeline and undo stores.
- **2026-10-05 (Claude): Phase 2 complete.**
  - Rust `sidecar.rs`, ported from VibeCut:
    - Command allow-list, locked `uv run` with a cleared environment, JSON-lines pump.
    - Cancel via the process group; kill-all on exit.
    - The Rust-owned agent session with start, ready and stop status, plus restart.
  - Python package `src-python/vibecut_agent/` (`protocol.py` is a port of VibeCut's `sidecar_protocol.py`) with `health` and `session` commands. It replaces Gemini's stub `src-python/main.py` and `src-python/core/`.
  - pytest suite in `tests/`, with pytest, ruff and strict mypy configured in `pyproject.toml`.
  - Bundling: the Python sources ship as Tauri resources, and the release venv lives in app data. Verified by building the `.app` and running its bundled session.
  - Frontend: `useSidecarStore`, `useSidecarBridge`, sidecar IPC wrappers, Agent-sidecar status in About and Settings (Settings has a Restart button), and the composer is blocked while the sidecar has an error.
- **2026-10-05 (Claude): Phase 3 complete (connection layer).**
  - Own Premiere CEP panel `com.vibecutagent.connect` (`src-premiere-panel/`), with an installer in Settings → Editors.
  - `premiere-watch` and `resolve-watch` watchers, plus the Premiere bridge and both hosts' `status`/`read_timeline`, ported from VibeCut.
  - Rust `nle.rs` supervisor with `nle_state`, `nle_call`, `nle_reconnect` and `nle-state`. `premiere_panel.rs` handles install, uninstall and status.
  - `sidecar.rs`: `Launch::for_resolve` and the `src-python/resolve_watch.py` launcher, because ResolvePython runs isolated. Every run now gets no-.pyc (`PYTHONDONTWRITEBYTECODE` for uv runs, `-B` for ResolvePython), and a missing program is named in the error.
  - `protocol.py` gains `LineChannel` and `StdinClosed`.
  - Frontend:
    - `useNleStateStore.applyState` replaces `setHostState` and `markDisconnected`.
    - New `NleState` shape with five statuses.
    - `useNleBridge`, plus `lib/nleStatus.ts` (`needsResync`, `connectionDetail`, `panelAdvice`).
    - Settings → Editors with Reconnect and panel Install/Update/Uninstall. The About modal shows editor details.
- **2026-10-05 (Claude): Phase 4 (4a) complete.**
  - **Chat agent:** VibeCut's Gemini and Claude loops ported (`vibecut_agent.agent`, with their tests), the `chat` command with Rust key injection, and the app-side controller, tools, snapshot and prompt.
  - **Editors:** marker and playhead commands for both, with Premiere panel → 0.2.0.
  - **B-roll:** analyzer ported (`vibecut_agent.broll`, `broll-analyze`/`broll-match`, the optional `energy` extra), and the B-roll panel UI.
  - **Plumbing:**
    - `tauri-plugin-dialog`, with `dialog:allow-open` only.
    - Python ≥ 3.13 (VibeCut's floor).
    - TypeScript target ES2022.
    - Endpoint disclosure in About.
- **2026-10-05 (Claude): Phase 4b complete.**
  - **Direct edits for both editors**, ported from VibeCut: 7 Python modules, 2 support modules, the `edits.py` dispatch, Premiere panel 0.3.0, and VibeCut's 63 edit tests.
  - **App side:** `lib/agent/edits.ts`, `editTools.ts` and `duck.ts`, the `useEditLogStore` log, the chat Revert button, and B-roll Place at playhead.
  - **Prompt:** the system prompt now lists what the agent can edit and how Revert works.
- **2026-10-05 (Claude): Keychain storage for API keys** (`secrets.rs`, `keyring` 3): the lookup order is environment, then Keychain. New commands `llm_key_set` and `llm_key_remove`, Settings → API keys, and the key's source shown in About.
- **2026-10-05 (Claude): Phase 5, the Spyglass B-roll Library.**
  - The B-Roll tab is now **Library | Folder**.
  - **Library:** VibeCut's B-roll browser over Spyglass's index (Rough Cut Studio Suite - Blair Themed), with folder scope, search/browse, pool, Source (also on thumbnail double-click), Import, Place and native drag into the editors.
  - **Rust:** `spyglass.rs`/`spyglass_archive.rs` ported, a chosen-index setting, `spyglass_start_drag` (the `drag` crate), the asset protocol for keyframes, and `broll-spyglass` in the allow-list.
  - **Python:** `broll/spyglass_index.py` + `run_spyglass`, and `nle/media.py` (`import_media`, `source_preview`) for both watchers.
  - **Premiere panel 0.4.0.**
  - **Agent:** `find_broll` (scoped by the Library), `list_spyglass_folders`, `describe_spyglass_folder`.
  - **Settings → B-roll Library** and an About row for the index.
- **2026-10-05 (Claude): Keep on Top of Editors** (`window_mode.rs`). The window floats above other apps and joins every Space, including a full-screen editor's (AppKit collection behaviors via `objc2-app-kit`, already in the tree). It is on by default, saved in the app config's `window.json`, and applied at launch before the window is shown. Toggles: the header pin, Settings → Window, and the tray's check item, all kept in sync by the `keep-on-top` event.
- **2026-10-06 (Claude): Phase 6a, project & sequences.**
  - The agent can make, copy, switch and rename timelines, and read, search and select the Media Pool / Project panel.
  - Each message's snapshot carries the pool.
  - Premiere panel 0.5.0.
  - Also before 6a, the Library drag was rebuilt: shots prepared ahead (`spyglass_prepare_drag`), a 160 px icon (`image` crate), and a synchronous main-thread `spyglass_start_drag`. Previews say "Opening … in the Source monitor…" at once.
- **2026-10-06 (Claude): Phase 5b, the B-roll panel in Premiere.**
  - VibeCut's B-roll CEP dock, ported as "VibeCut Agent B-roll" (panel 0.6.0).
  - Drag into the Project panel and timeline through CEP, double-click to preview in the Source monitor, and the Library's search, scope, pool, Import and Place, all served by the app over files (`broll_panel.rs`, `src/lib/brollPanel.ts`).
- **2026-10-06 (Claude): Phase 6b, transcripts and cuts by what's said.**
  - Local transcription (`transcribe`, with optional speaker labels and a Hugging Face token in the Keychain).
  - The transcript tools over the connected timeline.
  - VibeCut's draft, sent as a new timeline via `rebuild` (Premiere panel 0.7.0, and Resolve OTIO import, checked live).
  - `audio-peaks` for `find_silences`.
- **2026-10-06 (Claude): Phase 6c, audio sync.**
  - VibeCut's waveform engine (`audiosync.rs`) and its sync tools: `sync_and_place`, `sync_clips`, `slip_into_sync`, `link_clips` and `unlink_clips`.
  - Premiere panel 0.8.0 (`vcSetLinks`).
  - Revert now follows replaced ids inside link groups.
  - Checked live on Resolve.
- **2026-10-06 (Claude): Phase 6d, the Story Editor.**
  - `run_story_editor`: a story cut from the interviews' transcripts (and project or Library B-roll), made with the chat's model through the new `assemble` sidecar command (`vibecut_agent/story/`; Gemini, or Claude via structured outputs), opened as a draft and sent as a new timeline.
  - No music bed, by decision.
  - Checked live with both providers and a Resolve rebuild.
- **2026-10-06 (Claude): Phase 7 planned (7a, 7b, 7d), not built.** Claude without an API key: an MCP bridge to the agent's tools (files, no port), a "Claude (subscription)" chat provider running the user's Claude Code CLI, and remote edits through Claude Code's Remote Control. 7c (Claude desktop) left out by decision.
- **2026-10-06 (Claude): Phase 7 built (7a, 7b, 7d).**
  - **7a, the MCP bridge:** `mcp_bridge.rs`, `vibecut_agent/mcp_server.py` (the `mcp` extra, `mcp==2.3.0`) and `src/lib/mcp/server.ts`. Outside control is off by default; one driver at a time; outside edits are grouped for Revert.
  - **7b, Claude (subscription):** the `claude-code` chat provider (`claude_code.rs`, `agent/claude_code_chat.py`), two "(subscription)" models, and Settings → Claude subscription. No API key; Claude Code runs with only VibeCut's tools.
  - **7d, remote edits:** Settings → Outside control with **Copy Claude Code command**, and QUICKSTART's "Remote edits with Claude Code".
  - `snapshotFor` moved to `lib/agent/context.ts`; `runChatTool` factored out of the controller.
- **2026-10-06 (Claude): fix: `create_timeline` in Premiere no longer needs the connected sequence.** It read the connected sequence's frame rate first. When that sequence had been deleted or renamed ("Sequence 03" in "2026 Agent Tests", found live), every new sequence failed. The rate now comes from the connected sequence, else the one open in Premiere, else any in the project, else 25 fps (`_frame_rate_for_new`, premiere_project.py), with a regression test. Takes effect after Settings → Editors → Reconnect (Premiere), which restarts the watcher.
- **2026-10-06 (Claude): Phase 7e, the Story Editor on Claude (subscription) and a first pass for long footage.** `agent/claude_code_json.py`, `story/extract.py`, general model calls in `story/models.py`, `extraction`/`extractionKey` for `assemble`, the "first read" setting, and Claude Code kept in the sidecar's process group. Checked with real Claude Code on 12 and 2,100 lines.
- **2026-10-06 (Claude): fix: release builds now bundle `src-python/vibecut_agent/story/`** (missing since 6d, so the Story Editor and the 7e first pass would have failed in a release `.app`). `tests/test_bundle_resources.py` fails if any Python package folder isn't in `tauri.conf.json`'s `bundle.resources`.
- **2026-10-06 (Claude): fix: a Story Editor cut from a separately recorded WAV now takes its picture from the synced camera.**
  - **Found live in Premiere:** transcripts made from the recorder's WAVs put the WAV on V1 as well as A1 (`draftFromPlan`). Premiere imports such an XML as nothing at all, silently ("imported the rebuilt sequence's file but made no sequence from it").
  - **Reproduced:** diagnostic imports in "2026 Agent Tests" through the panel worked (a test clip, the real Ria MP4 + WAV under the space-prefixed ` Projects` folder, the synced layout with empty tracks), except a WAV on the picture track, which failed with exactly that error.
  - **Fix:** `syncedPictures(view)` (hostDraft.ts) maps each sound-only file linked to a camera clip in the connected timeline to that camera and its offset, and `draftFromPlan` puts the camera's picture on V1. A cut with no synced camera, or outside the camera's range, goes in as sound only, with a note.
  - **Guard:** `premiere_rebuild.refuse_sound_on_picture` refuses a sound-only file on a video track by name, before importing.
  - **Checked:** "VCA diag 5", made with the real offsets read from "ALW Course Piece" (Ria −120.8 s, Josie −118.9 s, Brandon −265.6 s), imported with all three cameras over their WAVs. This is the first confirmed working Premiere import of a send-draft (the "Not yet verified live: Premiere's rebuild" note under 6b).
  - **Left in that project for the user to delete:** the diagnostic sequences "VCA diag 1", "2", "3" and "5" in the "VibeCut" bin.
- **2026-10-06 (Claude): Phase 7f, Claude Code lockdown.**
  - **Checked each run:** every chat turn (7b) and every Story Editor or first-pass answer (7e) now checks Claude Code's own startup event (`lockdown_problem`, claude_code_chat.py).
    - A chat turn may have only `mcp__vibecut__*` tools and the `vibecut` MCP server.
    - A schema run (now `--output-format stream-json`, so it reports its startup) may have only `StructuredOutput` and no MCP server.
    - Anything else, or no startup report, stops Claude Code before it does anything, saying so. A future Claude Code that changed what `--tools ""` or `--strict-mcp-config` do can't widen what VibeCut runs.
    - A chat turn also stops with a clear message if VibeCut's MCP server didn't connect.
  - **Remote sessions:** Settings → Outside control now recommends **Copy remote session command**: `claude --remote-control vibecut --tools '' --strict-mcp-config --mcp-config '<VibeCut's server, inline>' --allowedTools 'mcp__vibecut__*'` (`remote_command`, mcp_bridge.rs). It needs no `claude mcp add`. The `claude mcp add` line stays, labelled as giving VibeCut to full-tool sessions.
  - **Tests:** Python 8 (each failure mode for chat and schema runs, plus the checker), Rust 1 (the remote command and its inline config).
  - **Checked with real Claude Code 2.1.291:**
    - A chat turn and a Story Editor cut passed the check.
    - The remote command's flags (in `-p` mode, stopped after startup) gave exactly `mcp__vibecut__get_editor_context` and the `vibecut` server. It's the one tool, since outside control was off.
  - **Not checked:** `--remote-control` itself with these flags, which needs the user's phone.
- **2026-10-06 (Claude): checkpoint commit** of Phases 5–7f (`7e18885`, branch `phase-8-persist-chats`). Nothing had been committed since the first commit.
- **2026-10-06 (Claude): Phase 8a, chats and Revert that survive a restart.**
  - `chat_store.rs` (`<app data>/history/`), `lib/agent/chatHistory.ts`, a saved edit log with `fromEarlierRun` and ids that never repeat, **Revert n edits (earlier session)**, and the History menu (⌘Y).
  - Fix: a Claude Code session that's gone no longer fails as a lockdown error; the turn starts a new session.
- **2026-10-06 (Claude): Phase 8a checked live in Resolve:** a fresh watcher reverted, from the saved log alone, an edit made before the "quit". The timeline matched clip by clip, and the scratch timelines were cleaned up.
- **2026-10-06 (Claude): Phases 8b–8d, the chat.**
  - **8b:** replies stream (`reply_delta` / `reply_break` / `reply_reset`, `agent/streaming.py`). Gemini moves to `streamGenerateContent` (SSE), the Claude API passes its text deltas on, and Claude Code runs with `--include-partial-messages`.
  - **8c:** Copy, Retry and Edit for the last message, which revert that request's edits first. `rewind` is saved with the chat, and Claude Code turns pass `--fork-session`, so the session before a turn stays resumable.
  - **8d:**
    - History search (`chat_search`) and renaming (`chat_rename`, F2);
    - the `chat-title` command, which names each new chat with its own model (Settings → Chat).
- **2026-10-06 (Claude): 8b's streaming checked live on Gemini and the Claude API** (a tool call each, and a second turn on the returned history). Committed as `5ac084a`.
- **2026-10-06 (Claude): Phases 8e–8h, a fuller chat.**
  - **8e:** Markdown replies (`react-markdown` + `remark-gfm`) with `t:` and SMPTE timecode chips that move the playhead.
  - **8f:** tool call cards (`ChatMessage.tool`), grouped per turn and folded after it.
  - **8g:** images with a message. New commands `chat_attachment_save` / `chat_attachment_load` file them under `history/attachments/<chatId>/`, a new `attachments` field goes in the chat protocol, and Claude Code runs with `--input-format stream-json`. The window sets `dragDropEnabled: false`, and the `base64` crate is a direct dependency.
  - **8h:** saved prompts (`usePromptStore`, `/` in the composer, Settings → Saved prompts).
- **2026-10-07 (Claude): checkpoint commit** of Phases 8e–8h (`890e089`).
- **2026-10-07 (Claude): Phase 9, effort, a usage tracker and the Mini Player.**
  - **9a:** Settings → Agent model gains Opus and Sonnet effort (medium by default). A new `effort` field goes in the `chat` request, and Claude Code turns pass `--effort`.
  - **9b:**
    - A new `rate_limit` chat event (from Claude Code's `rate_limit_event`), `costUsd` in subscription usage, and a new command `claude_code_usage` (`claude -p /usage`).
    - `useUsageStore`, and the header usage pill with its popover.
    - The About modal notes where the usage comes from. Nothing new is sent anywhere.
  - **9c:** a new `mini_player.rs` (`set_mini_player`, `mini_player_status`, the `mini-player` event, `miniPosition` in `window.json`), a tray "Mini Player" item, `core:window:allow-start-dragging`, and `MiniPlayer.tsx` on ⌥⌘M.
- **2026-10-07 (Claude): an easy way to launch the app.**
  - `scripts/install-app.sh` (`npm run install-app`) builds the app and installs it as `~/Applications/VibeCut Agent.app`.
  - `RunEvent::Reopen` shows the window, and the installed app opened by hand opens its window.
  - New `login_item.rs` with `tauri-plugin-autostart` (a LaunchAgent with `--at-login`), and Settings → Window → Open at login.
- **2026-10-07 (Claude): the menu-bar icon is "VA"** (`icons/tray-va.png`, a template image). **The header is one line:** the title moved to the window's title bar. **The Mini Player has rounded corners** (12 pt; a see-through window with its content layer clipped) and **takes focus when it appears** (the decoration change left it unfocused, seen live). **`install-app` signs with the Apple Development identity**, so the Keychain stops asking after each update.
- **2026-10-07 (Claude): Phase 10, a fuller B-Roll Analyzer (Analyze tab).**
  - Options (segment length, segments per clip, a new gap option, weights, workers) are shown and remembered (`useBrollStore` version 2, with a migration). The last run is kept, with a Re-score bar when options change.
  - Segment chips with ticks; an in-app player (`SegmentPreview.tsx`, new command `broll_preview_allow` in `broll_preview.rs`, CSP `media-src`); the Library's Source monitor call is shared as `openInSourceMonitor`.
  - Selects: Include (all / best N / minimum score), order, sequence name. **Export XML…** (new sidecar command `broll-export`, `dialog:allow-save`) and **Build timeline** (`create_timeline` + batched `add_clips`, one Revert step).
  - `minGapSec` added to `broll-analyze` and passed through `pipeline.py`.
- **2026-10-07 (Claude): one row of tabs.** Agent · Library · Analyze (⌘1–⌘3). The Library is a top-level tab (new `library` view and tray item "Open B-Roll Library"); B-Roll is renamed Analyze, and its Library/Folder sub-bar is removed (`BrollPanel.tsx` deleted, `useLibraryStore.view` dropped). New `TabBar.test.tsx`.
- **2026-10-07 (Claude): a shorter content-aware line.** The Analyze tab's checkbox reads "Content-aware scoring · energy, brief, search · first run ~2 GB" on one line; the full disclosure (local SigLIP 2, about 2 GB of packages, model weights from Hugging Face, offline after) moved to its tooltip. Settings and About still say where the model comes from.
- **2026-10-07 (Claude): the brief moved under Advanced** (with the weights, content-aware only). When a brief is set, the folded Advanced heading shows it ("Advanced · brief: …"), since it still counts.
- **2026-10-07 (Claude): Analyze tab order.** The options read: segment length / segments per clip / gap, then Content-aware scoring (and near-duplicates), then Advanced, then Analyze folder (`AnalyzerOptions` takes the content-aware controls as `contentAwareControls`).
- **2026-10-07 (Claude): a status bar at the bottom of the window.** The agent's state dot (Ready / Working / Stopping / Error / Offline) and its model moved from the top of the Agent tab to a new `StatusBar.tsx` footer under every tab (not in the Mini Player). The Agent tab's top row keeps Revert, History and New chat, right-aligned.
- **2026-10-07 (Claude): Phase 11.**
  - **11a:** Settings in five tabs (General, Agent, Accounts, Editors, Library). The sidecar section, local dependencies and the editors' detail lines moved to About (with Restart and Refresh).
  - **11b:** a message queue (`submitMessage`, `drainQueue`, `QueueList`, the Mini Player's "n queued").
  - **11c:** @-mentions (`mentions.ts`, `SuggestionList`, `MentionText`, the `[MENTIONED]` block, `ChatMessage.mentions`).
  - **11d:** Review edits first (`toolKinds.ts`, `review.ts`, pending/declined cards, the shield; new Rust command `mcp_hold`, the shim's `.hold`, `MCP_TOOL_TIMEOUT`).
  - **11e:** notifications (`tauri-plugin-notification`, `notification:default`, `notify.ts`, `useNotifyStore`, Settings → General → Notifications, an About row).
  - **11f:**
    - `PYTHONPYCACHEPREFIX` for release runs.
    - `agent/effort.py`, and `ChatError` in `chat_steps.py`; lazy imports in `headless.py`.
    - A cached Anthropic client and a Gemini session; the first words sent at once.
    - The parallel snapshot.
    - The warm job (a `chat` start without `userMessage`) and the warm Claude Code (`Launcher`, `prepare_turn`).
    - `turnTiming.ts` and the status bar tooltip.
- **2026-10-08 (Claude): Fix: `rearrange_sections` left zero-length clips that Premiere refused.**
  - `arrangeSections` (src/vibecut/lib/connect/hostDraft.ts) snapped the sections to frames but compared them with the clips' own edges, which Premiere reports rounded to the millisecond. A clip ending a fraction of a frame into a section left a sliver that snapped to zero length. The rebuild refused it with "must end after it starts". Seen while sorting a 94-clip B-roll selects sequence by clip name.
  - Clips are now compared on frame-snapped edges, and any piece under half a frame is dropped. `remove_time_ranges` and the transcript cuts go through the same function, so they get the fix too. Test: "leaves no zero-length clip …" in hostDraft.test.ts.
- **2026-10-08 (Claude): Phase 12a: send_to_premiere is built inside Premiere, from the project's own clips.**
  - The cause of the copies: the XML import made new master clips for media the project already had, and lost the clips' effects.
  - The fix: `premiere_native.py` clones the sequence, razors, lifts and moves the pieces, and places only what's new from existing project items. XML stays only for speed ramps.
  - Panel 0.9.0 adds `clone_sequence`, `razor_cuts`, `remove_transitions` and `delete_sequence`, and `move_items` takes `moves`. The rebuild timeout is now 300 s. See "Phase 12" → 12a.
- **2026-10-08 (Claude): Phases 12b–12d: speed, transitions, tracks and track switches.**
  - Ported from VibeCut: `set_clip_speed`, `set_transition`, `add_track`/`remove_track` and `set_track_options`, with their Revert, their panel functions and their tests.
  - The new tools are in `timingTools.ts`. A rippled speed change in Premiere goes into a draft. See "Phase 12" → 12b–12d.
- **2026-10-08 (Claude): Phase 12e: organizing the Media Pool / Premiere project.**
  - Ported VibeCut's `premiere_organize`/`resolve_organize`, their panel commands and their tests.
  - The new tools are in `poolTools.ts`. Their changes go in the edit log, so Revert undoes them with the timeline edits. See "Phase 12" → 12e.
- **2026-10-09 (Claude): Phase 12b–12e checked live in Resolve.**
  - Speed with and without ripple, a dissolve, tracks, track switches, and a pool label, flag, logging, rename and bin, on a scratch timeline with generated media.
  - All of them were reverted, and the timeline and the pool clip matched where they started. Everything was cleaned up.
- **2026-10-09 (Claude): A clear message when Premiere is running an older panel than the app.**
  - **Seen:** the user pressed Update panel (0.9.0 on disk), but Premiere kept running the 0.8.0 panel it had loaded. A resequence's send then failed with "Unknown command: clone_sequence".
  - **Fix:** `premiere_bridge.request` now turns the panel's "Unknown command" into a message naming the running panel's version (from `alive.json`) and asking for a restart of Premiere, or a close and reopen of the panel. Test in `test_premiere.py`.
  - **Still to do:** Settings → Editors could show the running version beside the installed one.
- **2026-10-09 (Claude): Phase 12a revised: send_to_premiere places pieces instead of moving them.**
  - **Live:** moving the clone's clips lost most of them in Premiere while the panel's reading said all was well.
  - **Fix:** the rebuild now places each piece from the project's own items into an emptied copy and checks every piece. The panel looks up each clip again before moving or removing it.
  - **Checked:** the user's 180-clip resequence, confirmed by their screenshot.
  - **Also:** one Python test failed once and then passed in three full runs; it hasn't been identified.
- **2026-10-09 (Claude): Phase 13a: a sharper snapshot.**
  - The first line has the playhead and the In/Out marks (Premiere panel 0.9.1; Resolve `GetMarkInOut`).
  - New `[SOURCES]` (the `media-info` command), `[TRANSCRIPTS]` and `[B-ROLL]` lines, fps on pool lines, and a `get_edit_log` tool.
  - New package `vibecut_agent/media/`, bundled in `tauri.conf.json`. See "Phase 13" → 13a.
- **2026-10-09 (Claude): Phase 13b: the agent sees footage.**
  - New tools `look_at_clip`, `look_at_timeline` and `look_at_media`, backed by the `media-frames` command (contact sheets).
  - Tool results can carry images to Claude, Gemini and Claude Code (MCP `ImageContent`); the history keeps a note in their place.
  - Budget: 8 images per request. Tool cards show what the agent saw.
  - Checked live with Gemini and Claude Code. See "Phase 13" → 13b.
- **2026-10-09 (Claude): Phase 13c: project memory.**
  - A Markdown notes file per editor project (`project_notes.rs`), first in every snapshot.
  - `remember_note` / `forget_note` change it, and the user edits it in Notes (status bar, ⌘⇧N).
  - Checked live with Gemini. See "Phase 13" → 13c.
- **2026-10-09 (Claude): Phase 13d: the agent hears loudness and beats.**
  - `measure_loudness`, `normalize_loudness` (through `set_clip_levels`, one Revert) and `find_beats`, on the new `media-loudness` and `media-beats` commands.
  - Phase 13 is built. Its live checks in Resolve and Premiere are listed under "Phase 13: still to check live".
- **2026-10-09 (Claude): Phase 13 checked live in Resolve.**
  - Ran on a scratch timeline with generated media: the snapshot's playhead, In/Out, sources and transcripts; `look_at_clip` and `look_at_timeline` frames accurate to the frame; loudness measured and normalized, then reverted exactly; beats at 120.4 BPM marked and removed. Everything was cleaned up.
  - `look_at_timeline` now labels frames by clip name, not by Resolve's long ids.
- **2026-10-09 (Claude): Phase 13a checked live in Premiere (panel 0.9.1).**
  - The playhead and the user's In/Out read back correctly.
  - Unset marks read -400000 s, which was handled but described wrongly; the comments are fixed and a test added.
- **2026-10-09 (Claude): Phase 14a: `review_edit`, the automatic check.**
  - VibeCut's edit lint is ported verbatim, with the delivery checks a QC needs: offline, switched off, strays past the end, picture with no sound, and loudness or true peak against a target.
  - Findings show on the tool card as positions to jump to. See "Phase 14" → 14a.
- **2026-10-09 (Claude): Phase 14b: the vision critic.**
  - The `critique` command (`review/critic.py`, ported from VibeCut's `gemini_critic.py`) runs on any of the chat's providers. Its model calls now take images, and Claude Code gets them over stream-json.
  - `review_edit` runs the critic by default, merging its notes with the automatic check.
  - Checked live with Gemini and Claude Code. See "Phase 14" → 14b.
- **2026-10-09 (Claude): Phase 14c: cut to the beat.**
  - `cut_to_beats` lays shots into the slots between every Nth beat of a music clip, on a free or new video track, with one Revert.
  - `beatsOf` is shared with `find_beats`. See "Phase 14" → 14c.
- **2026-10-09 (Claude): Phase 14d: vertical, square and 4:5 versions.**
  - `make_social_version` makes a copy at a social aspect.
    - Resolve: its own frame size, filled, with Smart Reframe on each clip.
    - Premiere: Auto Reframe Sequence, in panel 0.10.0.
  - The snapshot shows each timeline's frame size.
  - Probed and checked live in Resolve with 14a and 14c. See "Phase 14" → 14d and "checked live".
- **2026-10-09 (Claude): Phase 14e: ten new saved prompts** for the review, sound, beat, social and memory tools.
  - Existing users get them once, through a version 2 migration of the prompt store.
  - Phase 14 is built. See "Phase 14" → 14e and "still to check".
- **2026-10-09 (Claude): the critic runs on Gemini Flash by default.** The user prefers Gemini's API cost to the Claude API's.
  - Settings → Agent → Edit review critic: Gemini Flash (default) or the agent's model.
  - Without a Gemini key it falls back to the agent's model and says so. See "Phase 14" → "14b, revised".
- **2026-10-09 (Claude): Phase 15a: a tidier Agent row.**
  - The chat's name now opens History. Revert shortens to `Revert N`, New chat is an icon, and Review edits first moved into the composer.
  - Tests updated (history trigger name, Revert's visible text, the composer's review switch). See "Phase 15" → 15a.
- **2026-10-09 (Claude): Phase 15: captions and renders.**
  - Both are ported from VibeCut.
    - Captions: `create_captions`, through Resolve's own subtitles or a Premiere caption track.
    - Renders: `export_video` and `export_audio`, through Resolve's Deliver queue or Adobe Media Encoder, with progress and Stop.
  - Premiere panel 0.11.0. Not checked live yet. See "Phase 15".
- **2026-10-09 (Claude): Phase 15 checked live in Resolve; a render fix.**
  - Captions, 720p, WAV, AAC and Stop all held.
  - VibeCut's audio-only AAC job left Resolve rendering no picture afterwards, so AAC now comes from an H.264 carrier and every job starts from "H.264 Master". A refused start is tried once more.
  - See "Phase 15" → "Checked live in Resolve".
- **2026-10-09 (Claude): Phase 15 and 14d checked live in Premiere (panel 0.11.0).**
  - The caption track, a 720p render, WAV, Stop and Auto Reframe all worked.
  - Auto Reframe keeps the height (607x1080 at 9:16), and the tool now says so.
- **2026-10-10 (Claude): Phase 16a: the B-roll XML links in Resolve.**
  - Resolve refused the Analyze tab's XML because every file started at 00:00:00:00. The export now probes each source's start timecode, and the paths are percent-encoded under `file://localhost/`.
  - Checked live in Resolve with a five-variant repro. See "Phase 16a".
- **2026-10-10 (Claude): Phase 16b: names and colours for timeline clips.**
  - The agent's `label_timeline_clips` uses `label_clips` in both editors (panel 0.12.0).
  - Checked live in Resolve. See "Phase 16b".
- **2026-10-10 (Claude): Phase 16c: speed ramps.**
  - `set_speed_ramp` and `clear_clip_speed`, from VibeCut, work in the draft.
  - A ramp sent to Resolve was checked live. Resolve also imports a smooth xmeml ramp, noted as a later upgrade.
- **2026-10-10 (Claude): Phase 16d: the Story Editor's music bed.**
  - The cut snaps to the music's beats, and the bed goes on its own track of the draft.
  - Checked live in Resolve. See "Phase 16d".
- **2026-10-10 (Claude): Phase 16e: the agent drives the Analyzer.**
  - Three tools analyze a folder, export the selects as XML and build them as a timeline.
  - Build timeline lays selects on whole frames (a Phase 10 bug, fixed).
  - Checked live in Resolve. See "Phase 16e".
- **2026-10-14 (Claude): Fix: a busy Premiere no longer fails a send halfway through.**
  - **Seen live:** sending a 33-clip resequence of "Best B-Roll Selects - Outdoor School Meeting" failed with "Premiere didn't answer place_clip within 20 s. A dialog open in Premiere stops it answering". No dialog was open. Premiere was busy (about 118% CPU) and answered that `place_clip` 2.5 minutes later. The rollback then deleted the half-built copy, and the next calls queued behind it timed out too.
  - **Bridge:** a request the panel has started (`<id>.json.running`) gets `STILL_WORKING_S` (180 s) more while its heartbeat stays fresh. A timeout now says which case it was: started but not finished; not started because Premiere is busy with an earlier request; or, only when neither applies, the dialog message (`premiere_bridge.py`).
  - **Timeouts:** `place_clip` 90 s, plus `set_items`, `add_tracks`, `remove_transitions`, `open_sequence` and `delete_sequence`, which had the 20 s default (`premiere.py`). The app now waits 15 minutes for a `rebuild`, up from 300 s, the same as `send_to_premiere` gets over MCP (`nle.rs`).
  - Tests in `test_premiere.py`. Not checked live yet: the next send to a busy Premiere is the check.
- **2026-10-15 (Claude): Fix: Library folders no longer stay "(offline)" after their drives are attached.**
  - **Seen live:** all four watched roots were mounted, but the Library and the Premiere panel still showed them offline. The folder tree, with each folder's `online` flag, was read once per app run (`openLibrary`), so drives mounted after it opened never showed.
  - **Fix:** `recheckDrives` (`src/lib/library.ts`) reads the loaded folder levels again every 10 s and on window focus, using the existing `spyglass_folder_children`. The store changes only when a folder's drive came or went. No IPC change.
  - Tests in `library.test.ts`. Not checked live yet.
- **2026-10-16 (Claude): New: `export_clips` exports timeline clips each by itself.**
  - **Seen live:** asking the agent to export individual clips from a Premiere sequence failed with an error. No tool could export a clip by itself. The agent's only option was a run of `export_video` calls over each clip's span. That renders the whole mix (every track, titles, music) through Media Encoder one job at a time, and the sequence's In/Out marks are set and put back for each job.
  - **What it does:** each chosen clip is cut from its own source file between its `sourceIn` and `sourceOut` (plus `handles`, 0–60 s, clamped at the file's start) by ffmpeg. Nothing goes through the editor's render.
    - A video clip takes its linked sound from the same file, including the channel tracks Premiere splits a recording across. An audio-only clip becomes a 24-bit `.wav`.
    - Formats: `source` (H.264 CRF 18 + AAC `.mp4`), `prores` (422 HQ + PCM `.mov`), or `copy` (no re-encode; cuts land on the keyframe before the In).
    - Speed and reverse aren't applied, and the answer's `notes` says so for each such clip.
  - **Skipped, each with a reason, never failing the call:** transitions, adjustment layers and generators, titles, nested sequences and compound clips, stills, offline or missing files (naming the drive to attach), and disabled clips unless `includeDisabled`.
  - **Output:** a new folder `~/Movies/VibeCut Renders/<project>/<timeline> clips[ - name][ N]/`, with files `NN <clip name>.<ext>` in timeline order.
  - **Boundary:** three new watcher commands on both editors (`project.py` `_clip_export`), the same shared code for each (`nle/clip_export.py`, standard library only):
    - `export_clips {timeline, clipIds? | track?, handles?, format?, includeDisabled?, name?} -> {jobId, folder, total, skipped, notes}` reads the timeline and answers right away. A worker thread runs ffmpeg clip by clip.
    - `clip_export_status {jobId} -> {state, done, total, fraction, etaSeconds?, folder, files, failed}`. One clip failing doesn't stop the rest.
    - `cancel_clip_export {jobId}` keeps the finished files and removes the partial one.
    - No Tauri change: every call is quick, so the 35 s default timeout applies.
  - **Agent:** the `export_clips` tool (`renderTools.ts`) polls the status like a render, shows "Exporting clips n/N" as its activity, and stops with the chat. `RENDER_INSTRUCTION` sends per-clip requests here instead of a loop of `export_video`. Over MCP it is one of the `LONG_TOOLS`.
  - Tests in `tests/nle/test_clip_export.py` (real ffmpeg on generated sources) and `deliverTools.test.ts`. Not checked live yet in Premiere or Resolve. The exact Premiere error from the failed attempt wasn't recorded.
- **2026-10-16 (Claude): Fix: a busy Premiere no longer reads as a lost connection.**
  - **Seen live:** while the agent exported clips one at a time with `export_video` (two Media Encoder renders are in `renders/`, 09:47 and 10:29), the app kept showing Premiere disconnected.
    - About 30 replies sat unread in the bridge's `replies/` from 09:48 to 11:22. Nearly all were the watcher probe's `status`, plus two `sequence_info`.
    - Premiere answered each one after the bridge's 20 s wait. The panel's heartbeat stayed fresh, so Premiere was working, not gone.
    - Any probe timeout counted as `disconnected`, and the app then dropped Premiere as the active editor mid-export.
    - With the 2026-10-14 change, a probe whose `status` the panel had started could also wait 180 s more, holding up every call queued behind it.
  - **Fix:**
    - `errors.Busy` (a kind of `Unreachable`) is raised by `PremiereBridge.request` when nothing answered in time but the heartbeat is fresh. A stale heartbeat still raises plain `Unreachable`.
    - `request(..., patient=False)` skips the `STILL_WORKING_S` extension.
    - Replies to requests the bridge stopped waiting for are removed when they arrive (`_late`, `_sweep`), instead of piling up in `replies/`.
  - **Watcher (`PremiereAdapter.probe`):**
    - It waits at most `PROBE_TIMEOUT_S` (10 s) with `patient=False`.
    - It sends no `status` while the heartbeat says `busy`.
    - On `Busy` it reports the last state it read, so Premiere stays connected. Only a stale heartbeat, a new instance, or never having answered changes the state.
  - Calls that time out still fail with the same messages.
  - `export_clips` runs ffmpeg at `nice` 10 so a transcode doesn't slow Premiere.
  - Tests in `test_watch.py`. Not checked live yet.
- **2026-10-16 (Claude): Fix: per-clip Premiere renders that came out as the whole sequence (panel 0.12.1).**
  - **Seen live:** asked to export the 42 clips of "Oct Wall (no gaps)" as H.264 1080p files, the agent (a build without `export_clips`) made 42 `export_video` calls, each with the clip's `start`/`end`.
    - Files 21 and 40 are 130.163 s long, the whole sequence, at 330 MB each. Every other file is 3.003 s.
    - Both requests were ranged (60.06–63.063 and 117.15–124.157), and the panel answered 3.0 s and 7.0 s for them, yet Media Encoder ignored the In/Out.
    - The agent reported all 42 as done.
  - **Cause:** `vcEncode` set the sequence's In/Out, queued the job and put the old marks back straight after `encodeSequence` returned. Here that cleared them, because the sequence had none. Media Encoder doesn't always read the sequence by then, and workArea 1 with no marks renders all of it.
  - **Fix, panel (`host.jsx`):**
    - A ranged job's earlier marks are kept in `$.global.vcPendingMarks` and put back by `vcRestoreMarks` in the job's `onEncoderJobComplete`/`onEncoderJobError` handler, before its end is written. So the next per-clip job is queued only after the restore.
    - `vcEncodeCancel` puts back every pending job's marks, and a job Media Encoder refuses puts them back at once.
    - A job that never reported back hands its saved marks to the next ranged job on that sequence, so the user's own marks aren't lost.
    - Checked against a faked Premiere and Media Encoder in Node (there is no ExtendScript harness).
    - Panel 0.12.1: update it in Settings > Editors, then restart Premiere.
  - **Fix, check (`premiere_render.render_status`):** a finished file whose length (`renders.media_duration`, ffprobe) differs from what was asked by more than max(0.5 s, 2 %) is reported as failed and removed. The error names both lengths ("Media Encoder rendered 130.2 s instead of 60.06–63.063 s …"), so a wrong render is never handed over as done. Without ffprobe the check is skipped.
  - **`export_clips`** gains the `1080p` and `720p` formats (the short side, never enlarged, even sizes). `RENDER_INSTRUCTION` sends per-clip requests at any of these formats to `export_clips`, and uses one `export_video` per clip only when the user wants the clips as the editor plays them.
  - Tests in `test_premiere_render.py`, `test_renders.py` and `test_clip_export.py`. Not checked live yet. The earlier 2026-10-16 entries (`export_clips`, the busy probe) reach the app only after it is restarted.
- **2026-10-17 (Claude): Phase 17 step 0, Gemini through the Antigravity CLI.** Live checks of `agy -p` 1.2.1 are recorded under "Phase 17 (proposed)":
  - The caller tag reaches the MCP shim through agy's environment.
  - Workspace agents (`.agents/agents/`) give a system prompt, and `tools: [finish]` locks out shell and file tools.
  - `--conversation` doesn't carry earlier turns, so the app would keep the history itself.
  - Only Gemini 3.8 Flash is offered.
- **2026-10-17 (Claude): Phase 17 built: Gemini (subscription) through the Antigravity CLI.** See "Phase 17" for what was built and checked.
  - New files: `antigravity_chat.py`, `antigravity_json.py`, `antigravity.rs` and `AntigravitySection.tsx`.
  - The chat, chat titles and the Story Editor run on it. The critic refuses it (text only).
  - VibeCut's tools reach agy only after Settings → Gemini subscription → Add.
  - Tests: pytest, cargo and vitest all pass. Two chat turns and a title were checked live on the real agy. A tool call through the real shim isn't checked yet.
- **2026-10-21 (Claude): Fix: "Premiere Pro isn't running" in the middle of a render (panel 0.12.1).**
  - **Seen live:** asked to export 34 clips of a 2160×3840 sequence as H.264, the first `export_video` failed at 15:41:47 with "Premiere Pro isn't running." The agent told the user Premiere had disconnected.
    - Premiere answered that request 9 s later (`ok`, a Media Encoder job id), and Media Encoder rendered the file at 15:43.
    - Media Encoder was already running, so this wasn't a cold start: `encodeSequence` held Premiere for those 9 s.
  - **Cause:** the panel's heartbeat called `getHostEnvironment()` every beat, and that call waits on Premiere. So `alive.json` went stale while a request held Premiere. The bridge checks the heartbeat every second against `ALIVE_WITHIN_S` (5 s), so it gave up on a request the panel was running. The watcher then probed the same stale heartbeat and reported `disconnected`.
  - **Fix, panel (`bridge.js`):** the Premiere version is read once at load, so the heartbeat no longer calls into Premiere.
  - **Fix, bridge (`premiere_bridge.check_alive`):** while any request is `<id>.json.running`, a heartbeat up to `RUNNING_WITHIN_S` (60 s) old still counts as alive. Past that, the error says Premiere hasn't responded for that long and to restart it if it's frozen. With no request running, 5 s still means it isn't running.
  - Tests in `test_premiere.py` (a panel that stops stamping while it runs a request, both answering at 9 s and never answering). Not checked live yet. The bridge fix reaches the app on restart; the panel fix needs panel 0.12.1 installed and Premiere restarted.
- **2026-10-22 (Claude): Phase 16f: scale and position, still or keyframed (panel 0.13.0).**
  - The agent couldn't set a clip's scale or position in either editor. New tools: `set_clip_transform` and `get_clip_transform`.
  - New files: `nle/transforms.py`, `nle/premiere_transform.py` and `nle/resolve_transform.py`. The panel has the new `read_motion` and `set_motion` commands.
  - The change kind `"transform"` reverts in both editors.
  - Tests: pytest, vitest, mypy and ruff pass, and so does the panel version test in cargo. Checked live in Premiere; Resolve not yet. See "Phase 16f".
- **2026-10-26 (Claude): Phase 18a: `cut_by_speaker`, a multicam cut by who's talking.**
  - New: `src/lib/agent/multicamTools.ts` and its tests. `heardView` is exported from `transcriptTools.ts`. The tool is registered in `tools.ts`, `toolKinds.ts` (not reviewed: a draft cut), the system prompt and the MCP bridge's long tools.
  - Roadmap for Phases 18b–21 recorded under "Phase 18".
  - Tests: vitest (757), tsc, eslint, pytest and ruff pass. Not checked live yet.
- **2026-10-26 (Claude): Phases 18b and 18c: `make_split_edit` and `clean_dialogue`.**
  - New: `splitEditTools.ts`, `dialogueTools.ts`, `media/clean.py` and their tests. The sidecar command `media-clean` is added to `headless.py`, `sidecar.rs` and `src/types/sidecar.ts`.
  - Tests: vitest (768), tsc, eslint, pytest (966), mypy, ruff and cargo pass. Not checked live yet.
- **2026-10-26 (Claude): Phase 18 live pass in Resolve; a fix to `cut_by_speaker`'s lead.**
  - Checked live over MCP on "VCA 18 probe": `cut_by_speaker` by loudness, `make_split_edit` (J), `clean_dialogue` and its Revert. See "Phase 18".
  - Fixed: a short overlap at a speaker handoff now goes to the incoming speaker, so cuts land before the words, not 0.12 s after. New test in `multicamTools.test.ts`.
  - Probed Text+ titles for 18d: `InsertFusionTitleIntoTimeline` ripple-inserts on V1, so lower thirds will be PNGs with alpha laid by `add_clips`.
- **2026-10-26 (Claude): Phase 18 live pass in Premiere, 18a by transcript, and 16f in Resolve; five fixes.** See "Phase 18" and "Phase 16f" for what was checked.
  - **`cut_by_speaker` by transcript (`multicamTools.ts`):** with a mic each, Whisper transcribes the other person's bleed, so every line counted for every angle and the cut went to the wide. `bleedGroups` finds a line heard on two files (same words, same time) and `keepLoudest` keeps it on the loudest mic (`audio-peaks`, run only when there is such a line). Tests in `multicamTools.test.ts` (pure, and end to end).
  - **Resolve moves (`resolve_transform.py`):** keys are read from the comp's BezierSplines (the Transform's `GetKeyFrames` answers its range); a move that can't be deleted (the clip's active comp) is left as a pass-through; and each change is exported and imported again, since Resolve renders a script-changed comp as it was. The Fusion fakes in `test_resolve_edit.py` behave as 21.1 did.
  - **Premiere `add_clips` (`premiere_edit._plan_place`):** a clip's unwanted half (a camera laid picture-only) held its tracks for the clips after it in the call, though it is lifted before the next one is placed. "Mic on A1 under a picture-only camera" was refused. Now only the parts that stay hold their tracks. Test in `test_premiere_edit.py`.
  - **Premiere `send_to_premiere` (`premiere_native.py`):** a piece without its picture or sound was placed with that track as −1, which Premiere takes as the first track. So each picture-only angle of a multicam overwrote the mic on A1, which came out 0–8 s of 30. The unwanted half now goes on scratch tracks past the draft's (found with `Probe`), which are removed again at the end. The fake now places −1 on the first track, as Premiere did. Test in `test_premiere_native.py`.
  - **Premiere sound-only files (`premiere_edit.place_clip_exact`, used by `add_clips`, Revert and the native send):** checked with a render (export_audio, cross-correlated with the source), Premiere 26.5.2 places a file with no picture one frame earlier in it than asked, and from 0 a frame short. Every send and cleaned copy moved a WAV mic a frame against its picture. A placement off by up to two frames is lifted and placed again that much later; camera files were exact and aren't checked. Rechecked live: from 0, mid-file and to the file's end all exact. Tests in both Premiere test files (the fakes can land sound-only files a frame early).
  - Tests: pytest (971, 2 skipped), vitest (771), tsc, eslint, mypy and ruff pass. The app was reinstalled with all five (`npm run install-app`); no panel update is needed.
  - Left on the scratch projects: Resolve's "VCA 18 probe" (timelines "Transcript multicam", "L cut probe", "Move probe" and their VibeCut copies) and an unsaved Premiere project opened from a scratch copy of an empty one. A render in `~/Movies/VibeCut Renders/` was deleted.
- **2026-10-26 (Claude): Phase 18d: `add_lower_thirds`.** See "18d".
  - New: `media/titles.py` (the sidecar command `media-titles`, added to `headless.py`, `sidecar.rs` and `src/types/sidecar.ts`), `src/lib/agent/titleTools.ts`, and their tests. Registered in `tools.ts`, `toolKinds.ts` (reviewed; the card counts `thirds`), the system prompt and the MCP bridge's long tools.
  - `withoutBleed` (with `SoundPiece` and `pieceLevels`) is pulled out of `cut_by_speaker` into an export of `multicamTools.ts`, for both tools.
  - Tests: vitest (778), tsc, eslint, pytest (975, 2 skipped), mypy, ruff and cargo (142) pass. Checked live in Premiere and Resolve.
  - Premiere was closed (with a TERM signal, since a save dialog held its quit) to let the app connect to Resolve; its scratch project was discarded, as agreed.
- **2026-10-26 (Claude): Phase 19a: `close_gaps`, `insert_clip` and `replace_clip`.** See "19a".
  - New: `src/lib/agent/draftEditTools.ts` and its test. Registered in `tools.ts`, `toolKinds.ts` (not reviewed: draft edits) and the system prompt. The prompt's "can't do yet" line now says ripple edits (closing gaps, inserts) go through the draft.
  - `hostDraft.ts`: `EditOptions.withPicture` (insert and overwrite without picture) and an exported `draftGroup`.
  - Tests: vitest (791), tsc and eslint pass. No Python changes. Not checked live yet.
- **2026-10-26 (Claude): Phase 19a live pass in Resolve and Premiere; stills refused.** See "19a".
  - `insert_clip` and `replace_clip` refuse stills (the rebuild can't lay them); test added. The app was reinstalled (`npm run install-app`).
  - Tests: vitest (791), tsc and eslint pass.
  - Left on the scratch projects: Resolve's "VCA 18 probe" (timelines "19a probe" to "19a probe 4", "19a add probe", their backups and "19a probe 4 (VibeCut 1)") and Premiere's "VCA 19 probe" (unsaved, in this session's scratchpad). The render was deleted.
- **2026-10-26 (Claude): outside MCP calls keep a timeline they just made.** See "19a" (Seen on the way). `server.ts` only; tests: vitest (793), tsc and eslint pass. The app was reinstalled. Checked live in Premiere; left on "VCA 19 probe": "lag probe" and "lag probe 2".
