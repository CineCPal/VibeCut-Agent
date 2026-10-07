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
| command | `sidecar_start` | `sidecar.rs` | `startSidecar(jobId, command, request)` | starts a job from the `COMMANDS` allow-list: `health`, `chat` (interactive; Rust injects the provider's key, or for `claude-code` the Claude Code setup as `claudeCode`, Phase 7b), `broll-analyze`, `broll-match`, `broll-spyglass` (Rust sets its `indexPath`; `--extra energy` per `extras_for`), `transcribe` (`--extra transcribe`, plus `diarize` and the HF token only when it labels speakers), `audio-peaks`, and (6d) `assemble` (Rust injects the chat provider's key, as for `chat`: `needs_llm_key`). Rust-owned commands (`session`, the watchers) are refused |
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
| event | `navigate` | `tray.rs` → main window | `onNavigate(cb)` | `"chat" \| "broll" \| "settings" \| "about"` |
| event | `sidecar-event` | `sidecar.rs` | `onSidecarEvent(cb)` | `{ jobId, command, event }`; `event` is one protocol object `{ type, ... }`. Chat: `status`, `retry`, `tool_calls`, `result`, `error`. B-roll: `starting`, `status`, `progress {fraction, phase, detail}`, `result`, `error`, `done` |
| plugin | dialog `open` | `tauri-plugin-dialog` | `chooseFolder(title)` | the B-roll folder picker; only `dialog:allow-open` is granted |
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

**Not yet verified live:**
- Gemini's and the Claude API's streaming, which need their keys: one turn each with a tool call, and the next turn accepted.
- The app itself: a streamed reply on screen, and Copy in the Tauri webview. If `navigator.clipboard` is refused there, add `tauri-plugin-clipboard-manager` with only `allow-write-text`.
- Retry and Edit, and "Revert & retry" on a scratch Resolve timeline.
- Search, rename and a model name across a relaunch.

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
  - *(2026-10-06)* **Phases 8b–8d are built:** streaming replies on all three providers, Copy/Retry/Edit (Claude Code turns now fork their session), and History search, rename and model-written names (`chat-title`). Next: the user's own try (with 8a's), Gemini and Claude API streaming with their keys, "Revert & retry" on a scratch Resolve timeline, then Premiere and Phase 7's live checks.
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
