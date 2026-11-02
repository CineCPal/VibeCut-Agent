# VibeCut Agent — Multimodal Model Audit, Provider Consolidation & Migration Plan for Claude Code CLI

**Document ID:** `vibecut.model.migration.v2`
**Status:** Ready for Execution (Claude Code CLI Plan Mode)
**Target Branch:** `feat/model-allocation-optimization` (or current active feature branch)
**Governance Contract:** Must preserve `EXECUTION_MODE=direct` (`VIBECUT_EXECUTION_MODE=direct`) and `EXECUTION_MODE=orchestrated` contracts (`AGENTS.md` §11, `CLAUDE.md`, `ORCHESTRATOR_SPEC.md` §2.2).

> **Executed 2026-11-02, with these departures** (PLAN.md, "Model migration v2", decisions D1-D18): Gemini's tiers are **`gemini-3.8-flash` and `gemini-3.1-pro-preview`** with `thinkingLevel`, not the 2.5 pair with `thinkingBudget` (2.5 is closed to new projects); the 404 fallback goes Pro → Flash → `gemini-flash-latest` and is announced. The VLM default is **`qwen3-vl:8b`** (with `qwen2.5vl:7b` as its alias); the Whisper tier is named `large-v3-turbo`. **Gemini does not orchestrate** (the user's call): it edits directly in either execution mode, and only Claude (subscription) orchestrates; the spec's "Enable `ExecutionMode.ORCHESTRATED` for `provider == \"gemini\"`" is not done. Gemini defaults to Flash everywhere, the Story Editor's narrative pass included (it uses Pro only when the chat is set to Gemini Pro). Embedding models have no aliases. Added at the user's request: chat titles on the local Gemma first, and a Local (Qwen3-VL) option for the review critic.

---

## 1. Executive Summary & Target Architecture Diff

This plan executes two major architectural consolidations alongside targeted model migrations across VibeCut Agent's cloud and local multimodal pipelines:

1. **Provider Consolidation (Cloud Tier):**
   - **Remove Antigravity (`provider: "antigravity"`, "Gemini (subscription)"):** Delete the headless `agy -p` wrapper (`antigravity.rs`, `antigravity_chat.py`, `antigravity_json.py`, `AntigravitySection.tsx`). **Gemini is now accessed exclusively via the Gemini API (`GEMINI_API_KEY`, `provider: "gemini"`).**
   - **Remove Anthropic API (`provider: "claude"`, `ANTHROPIC_API_KEY`):** Delete the raw Anthropic SDK path (`claude_chat.py`, `claude_client.py`, `Provider::Anthropic` in `secrets.rs`, `anthropic` row in `ApiKeysSection.tsx`, and the `anthropic` Python dependency in `pyproject.toml`). **Claude is now accessed exclusively via the user's signed-in Claude Code CLI subscription (`provider: "claude-code"`).**
2. **Model-to-Task Reallocation (Cloud & Local Sub-Agents):**
   - Upgrade Gemini API from a single un-tiered `gemini-flash-latest` alias to explicit **Gemini 2.5 Flash (`gemini-2.5-flash`)** and **Gemini 2.5 Pro (`gemini-2.5-pro`)** choices with `thinkingConfig` support and full `ExecutionMode.ORCHESTRATED` compatibility.
   - Upgrade local STT (`WhisperWorker` & `transcribe/pipeline.py`) default from `whisper-medium` to **`whisper-large-v3-turbo`** (`mlx-community/whisper-large-v3-turbo`) for 3–4x faster Apple Silicon decoding with `large-v3` word-level accuracy.
   - Fix local Ollama default model tags in `OrchestratorConfig` (`qwen2.5vl:7b`, `gemma3:4b`) with alias resolution (`MODEL_ALIASES`), switch `GemmaValidator` to zero-latency deterministic mode by default (`VIBECUT_VALIDATOR_MODE="deterministic"`), upgrade `VlmWorker` from single-frame motion guessing to a **3-frame temporal contact strip** (`[START | MID | END]`), and refactor multi-file `Ingest.run()` to execute in **stage-major order** to eliminate unified memory model-swapping thrash.

---

### 1.1 Consolidated Provider & Sub-Agent Allocation Matrix

| Subsystem / Agent | Previous Models / Providers | Target Models / Providers | Fallback Option | Core Architectural Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **1. Interactive Chat & Supervising Editor (Claude)** | • Anthropic API (`claude`: `claude-opus-5-5`, `claude-sonnet-5-5`)<br>• Claude Code CLI (`claude-code`: `claude-opus-5-5`, `claude-sonnet-5-5`) | **Claude Code CLI only (`provider: "claude-code"`):**<br>• `claude-code-sonnet-5-5` (`claude-sonnet-5-5`, default)<br>• `claude-code-opus-5-5` (`claude-opus-5-5`) | Gemini API (`gemini-2.5-flash` / `gemini-2.5-pro`) | Eliminates duplicate Anthropic API key plumbing and the `anthropic` SDK cold-start overhead (~0.6s); runs both `direct` and `orchestrated` modes via `claude_code_chat.py` + `mcp_server.py`. |
| **2. Interactive Chat & Supervising Editor (Gemini)** | • Gemini API (`gemini-flash-latest`, `direct` mode only)<br>• Antigravity CLI (`antigravity`: `gemini-4-argon`, `gemini-3.8-flash`, text-only) | **Gemini API only (`provider: "gemini"`):**<br>• `gemini` (`gemini-2.5-flash`, default fast tier)<br>• `gemini-pro` (`gemini-2.5-pro`, deep reasoning tier)<br>Both with `thinkingConfig` + `orchestrated` mode enabled | `gemini-flash-latest` (automatic HTTP 404 fallback) | Removes fragile `agy -p` text-only CLI scraping and global `~/.gemini/config/mcp_config.json` mutation; adds native multimodal + thinking-budgeted Flash/Pro tiers. |
| **3. Chat Auto-Titler (`chat-title`)** | Active chat model (`claude-opus-5-5`, `claude-code`, `antigravity`, or `gemini-flash-latest`) | • On `gemini`: `gemini-2.5-flash`<br>• On `claude-code`: `claude-sonnet-5-5` (`effort="low"`, never Opus) or `gemini-2.5-flash` if `GEMINI_API_KEY` is set | `gemini-flash-latest` / `claude-sonnet-5-5` | Prevents burning `claude-opus-5-5` subscription quota on a 2–6 word JSON chat title (`agent/titles.py`). |
| **4. Story Editor Pass 1: Chunk Extractor (`story/extract.py`)** | `claude-sonnet-5-5` (API/CLI), `gemini-flash-latest` (API), `gemini-3.8-flash` (`antigravity`) | • `gemini-2.5-flash` (when `provider == "gemini"` or `storyFirstPass == "gemini"`)<br>• `claude-sonnet-5-5` (`effort="low"` via `claude-code`) | `gemini-flash-latest` | Removes `antigravity` and Anthropic API extractors; uses `gemini-2.5-flash` or low-effort `claude-sonnet-5-5` for fast verbatim line-range filtering across 1,500-line chunks. |
| **5. Story Editor Pass 2: Narrative Assembler (`story/models.py`)** | `claude-opus-5-5` / `claude-sonnet-5-5` (API/CLI), `gemini-flash-latest` (90s timeout), `antigravity_story` | • `claude-code`: `claude-opus-5-5` / `claude-sonnet-5-5` (`effort="high"`, 300s timeout)<br>• `gemini`: `gemini-2.5-pro` (`thinkingBudget=8192`, 180s timeout) | `gemini-2.5-flash` (`thinkingBudget=4096`) | Removes `claude_story` (API) and `antigravity_story`; upgrades Gemini Pass 2 narrative assembly from un-budgeted Flash to `gemini-2.5-pro`. |
| **6. Edit Review Vision Critic (`review/critic.py`)** | `gemini-flash-latest` (default) or active chat model; **hard-failed on `antigravity`** | • `criticModel="gemini"` (default): `gemini-2.5-flash`<br>• `criticModel="same"` on `claude-code`: `claude_code_json_answer` (multimodal stream-json stills) | `gemini-flash-latest` | Removing `antigravity` eliminates the text-only critic failure completely; both `gemini` and `claude-code` natively accept JPEG review stills. |
| **7. Local Pre-Flight Validator (`workers/gemma_validator.py`)** | `VIBECUT_GEMMA_MODEL="gemma3:4b-it"` (invalid Ollama tag; runs on every `propose_otio_delta` without transcript context) | **Default:** `VIBECUT_VALIDATOR_MODE="deterministic"` (0ms LLM call)<br>**Opt-in (`"llm"`):** `gemma3:4b` with cut-point transcript word context | Deterministic `otio_delta.compile_to_nle_commands` | `otio_delta.py` handles 100% of structural/collision/lock/channel math deterministically; eliminates 1–30s of false-positive local LLM latency by default. |
| **8. Local Vision Worker (`workers/vlm_worker.py`)** | `VIBECUT_VLM_MODEL="qwen2.5-vl:7b-instruct"` (invalid Ollama tag; 1 static midpoint JPEG per shot) | `VIBECUT_VLM_MODEL="qwen2.5vl:7b"` with **3-frame temporal contact strip** (`15% / 50% / 85%`) + `keep_alive="10m"` | `qwen2.5-vl:7b-instruct` / `gemma3:4b` (via alias resolver) | Matches Ollama's official `qwen2.5vl:7b` tag and grounds `camera_movement` (`PAN_LEFT`, `DOLLY_IN`, `STATIC`) in a 3-frame temporal strip instead of 1 still image. |
| **9. Local STT Worker (`workers/whisper_worker.py` & `transcribe/pipeline.py`)** | `mlx-community/whisper-medium-mlx` (`medium` default; `faster-whisper` reloads model every file) | `mlx-community/whisper-large-v3-turbo` (`large-v3-turbo` default tier) + in-process `faster-whisper` model cache | `mlx-community/whisper-medium-mlx` / `deepdml/faster-whisper-large-v3-turbo-ct2` | 4-layer turbo decoder delivers `large-v3` word-level timestamp accuracy at 3–4x faster speed on Apple Silicon. |
| **10. Local Vector Store & Ingest (`workers/vector_store.py`, `workers/ingest_pipeline.py`, `broll/vision_energy.py`)** | `BAAI/bge-m3` (strict tag); per-file `vision -> index` loop thrashes Ollama RAM; `vision_energy.py` ignores `GpuLock` | Auto-resolved `bge-m3` / `nomic-embed-text` + **stage-batched `Ingest.run()`** + `GpuLock` in `vision_energy.py` | SQLite FTS5 lexical search | Prevents Ollama from evicting/reloading 5.6 GB VLM and embedding models on every file in a batch and serializes Metal GPU access. |

---

### 1.2 Summary of Files to Delete, Dependencies to Remove & Env Vars to Update

#### A. Files to Delete Completely (Antigravity & Anthropic API Removal)
1. **Rust (Tauri):**
   - `src-tauri/src/antigravity.rs`
2. **Python Sidecar:**
   - `src-python/vibecut_agent/agent/antigravity_chat.py`
   - `src-python/vibecut_agent/agent/antigravity_json.py`
   - `src-python/vibecut_agent/agent/claude_chat.py`
   - `src-python/vibecut_agent/agent/claude_client.py`
3. **Frontend (React / TypeScript):**
   - `src/components/settings/AntigravitySection.tsx`
   - `src/components/settings/AntigravitySection.test.tsx`
4. **Tests:**
   - `tests/agent/test_antigravity_chat.py`
   - `tests/agent/test_claude_chat.py`
   - `tests/agent/claude_fakes.py`

#### B. Dependencies & Environment Variables Diff
| Item | File Path | Old Value / State | New Value / State |
| :--- | :--- | :--- | :--- |
| `"anthropic>=0.80.0"` | `pyproject.toml` | Required base dependency | **Removed** (Claude runs exclusively via `claude-code` CLI subprocess) |
| `CLAUDE_KEY_ENV` (`ANTHROPIC_API_KEY`) | `src-tauri/src/sidecar.rs`, `src-tauri/src/secrets.rs` | Stored in Keychain / resolved for `provider == "claude"` | **Removed** from `secrets.rs` (`Provider::Anthropic`, `KeyStatus.anthropic`) and `sidecar.rs` (`prepare_request`). Still stripped from child env in `claude_code_chat.py` `DROPPED_ENV` and `sidecar.rs` `passes_to_child`. |
| `ChatProvider` | `src/types/agent.ts` | `"gemini" \| "claude" \| "claude-code" \| "antigravity"` | `"gemini" \| "claude-code"` |
| `AiProvider` & `KeyProvider` | `src/types/agent.ts`, `src/types/system.ts` | `AiProvider = "gemini" \| "anthropic"`; `KeyProvider = "gemini" \| "anthropic" \| "huggingface"` | `AiProvider = "gemini"`; `KeyProvider = "gemini" \| "huggingface"` |
| `AiChoiceId` | `src/types/agent.ts` | 7 choices (`gemini`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-code-*`, `antigravity-*`) | 4 choices: `"gemini"` (Gemini 2.5 Flash), `"gemini-pro"` (Gemini 2.5 Pro), `"claude-code-opus-5-5"` (Claude Opus 5.5), `"claude-code-sonnet-5-5"` (Claude Sonnet 5.5) |
| `VIBECUT_WHISPER_MODEL` | `src-python/vibecut_agent/config.py` | `"mlx-community/whisper-medium-mlx"` | `"mlx-community/whisper-large-v3-turbo"` |
| `VIBECUT_VLM_MODEL` | `src-python/vibecut_agent/config.py` | `"qwen2.5-vl:7b-instruct"` | `"qwen2.5vl:7b"` (with alias resolution for `"qwen2.5-vl:7b-instruct"`) |
| `VIBECUT_GEMMA_MODEL` | `src-python/vibecut_agent/config.py` | `"gemma3:4b-it"` | `"gemma3:4b"` (with alias resolution for `"gemma3:4b-it"`) |
| `VIBECUT_VALIDATOR_MODE` | `src-python/vibecut_agent/config.py` | Always calls Ollama if reachable | `"deterministic"` (default) or `"llm"` |

---

## 2. Step-by-Step Execution Phases for Claude Code CLI

> **Instructions for Claude Code CLI:**
> Execute Phases 1 through 5 in order. Run the verification commands at each phase boundary to ensure clean compilation and zero regressions.

---

### Phase 1: Remove Antigravity (`antigravity`) & Anthropic API (`claude`) Across Rust, Python, and Frontend

#### Step 1.1: Remove Antigravity & Anthropic API Key from Rust (`src-tauri/`)
1. **Delete `src-tauri/src/antigravity.rs`.**
2. **Edit `src-tauri/src/lib.rs`:**
   - Remove `mod antigravity;` (line 1).
   - Remove `antigravity::antigravity_status`, `antigravity::antigravity_set`, `antigravity::antigravity_add_tools`, and `antigravity::antigravity_remove_tools` from `tauri::generate_handler![...]` (lines 135–138).
3. **Edit `src-tauri/src/secrets.rs`:**
   - Remove `CLAUDE_KEY_ENV` from the `use crate::sidecar::...` import (line 14).
   - Remove `Anthropic` from `pub enum Provider` (line 26) and `Provider::env()` (line 37) so `Provider` is solely `Gemini` and `Huggingface`.
   - Remove `pub anthropic: bool` and `pub anthropic_source: Option<KeySource>` from `pub struct KeyStatus` (lines 125, 127) and `pub fn status()` (lines 134, 138, 140).
   - Update unit tests in `secrets.rs` (`status_says_where_each_key_came_from`, `providers_name_their_variables`) to remove `anthropicSource` and `Provider::Anthropic`.
4. **Edit `src-tauri/src/sidecar.rs`:**
   - Remove `pub const CLAUDE_KEY_ENV: &str = "ANTHROPIC_API_KEY";` (line 225). (Keep `"ANTHROPIC_API_KEY"` blocked in `passes_to_child` and its test!)
   - Simplify `prepare_request(command: &str, mut request: Value, gemini_key: Option<&str>, subscription: Option<Value>) -> Result<Value, String>`:
     - Always remove `"apiKey"`, `"claudeCode"`, `"antigravity"`, `"extractionKey"` from incoming `object` so the webview can never inject credentials or binaries.
     - Support only two providers when `needs_llm_key(command)` is true:
       - `provider == crate::claude_code::PROVIDER` (`"claude-code"`): requires `subscription` (`"Claude Code isn't set up. See Settings → Claude subscription."`) and inserts `"claudeCode"`.
       - `provider == "gemini"`: requires `gemini_key` (`"GEMINI_API_KEY is not set. Add it in Settings → API keys, or choose Claude."`) and inserts `"apiKey"`.
       - Any other `provider` returns `Err(format!("Unknown AI provider {other:?}"))`.
   - In `orchestrated_extras(command, request, mode)` (line 542):
     - Change `let claude = ...` to `let gemini = request.get("provider").and_then(Value::as_str).unwrap_or("gemini") == "gemini";` so an orchestrated `"gemini"` chat gets `vec!["orchestrator", "transcribe"]` (while `"claude-code"` gets its orchestrated extras via `claude_code.rs` `shim_launch_with`).
   - In `sidecar_start` (lines 884–900):
     - Resolve only `gemini_key` (when `needs_llm_key(spec.name)`) and `subscription` only for `Some(crate::claude_code::PROVIDER)`.
   - Update unit tests in `src-tauri/src/sidecar.rs` to match the 4-argument `prepare_request` signature and remove `antigravity` / `"claude"` API-key test cases.

#### Step 1.2: Preserve `to_claude_content` & Remove `antigravity_*.py` and `claude_*.py` in Python (`src-python/`)
1. **Move `to_claude_content` into `src-python/vibecut_agent/agent/claude_schema.py`:**
   - Copy `to_claude_content(parts: list[dict[str, Any]]) -> list[dict[str, Any]]` (from `claude_client.py` lines 188–205) into `claude_schema.py`. This keeps multimodal image block conversion available for `claude_code_json.py` / `review/critic.py` with zero external SDK dependencies.
2. **Delete the 4 obsolete Python modules:**
   - `src-python/vibecut_agent/agent/antigravity_chat.py`
   - `src-python/vibecut_agent/agent/antigravity_json.py`
   - `src-python/vibecut_agent/agent/claude_chat.py`
   - `src-python/vibecut_agent/agent/claude_client.py`
3. **Remove `"anthropic>=0.80.0"` from `pyproject.toml`:**
   - Remove `"anthropic>=0.80.0",` from `dependencies` in `pyproject.toml` (line 11) and run `uv lock` so the lockfile stays in sync.
4. **Update `src-python/vibecut_agent/agent/chat.py`:**
   - Update `PROVIDER_NAMES` to `{"gemini": "Gemini", "claude-code": "Claude (subscription)"}`.
   - In `run(request, emitter, cancel, stdin_lines)`:
     - Reject unknown providers (including removed `"claude"` and `"antigravity"`).
     - Keep two branches:
       1. `provider == "claude-code"`: runs `claude_code_chat.run_chat_turn` with `Launcher` warm-start and `orchestrated = config.execution_mode == ExecutionMode.ORCHESTRATED`.
       2. `provider == "gemini"`: resolves the turn runner via `resolve_chat_turn_runner("gemini", config)` (which returns `gemini_chat.run_chat_turn` in `direct` mode and `make_orchestrated_turn_runner(config)` in `orchestrated` mode).
5. **Update `src-python/vibecut_agent/config.py` and `src-python/vibecut_agent/orchestrator/supervisor.py`:**
   - In `config.py`, `resolve_chat_turn_runner(provider: str, config: OrchestratorConfig | None = None)`:
     - Only accepts `provider == "gemini"` (raising `ValueError(f"Unknown chat provider: {provider!r}")` otherwise; note that `"claude-code"` is routed in `chat.py` and `mcp_server.py`).
     - In `ExecutionMode.ORCHESTRATED`, returns `make_orchestrated_turn_runner(cfg)` from `vibecut_agent.orchestrator.supervisor`.
     - In `ExecutionMode.DIRECT`, returns `gemini_chat.run_chat_turn`.
   - In `orchestrator/supervisor.py`:
     - Replace `from vibecut_agent.agent import claude_chat` with `from vibecut_agent.agent import gemini_chat`.
     - In `make_orchestrated_turn_runner(config: OrchestratorConfig)`, call `gemini_chat.run_chat_turn(...)` inside `run_turn()`. (Both `gemini_chat.run_chat_turn` and the former `claude_chat.run_chat_turn` share the exact same callback signature, so `_Router` works without modification!)
6. **Update `src-python/vibecut_agent/agent/titles.py`:**
   - Update `PROVIDERS` to `{"gemini": "Gemini", "claude-code": "Claude (subscription)"}`.
   - Remove `claude_title()` and `antigravity_json_answer()`.
   - For `provider == "claude-code"`, call `claude_code_json_answer` with `model="claude-sonnet-5-5"` and `effort="low"` (never Opus).
   - For `provider == "gemini"`, call `gemini_title` with `model="gemini-2.5-flash"` (falling back to `"gemini-flash-latest"`).
7. **Update `src-python/vibecut_agent/story/models.py`, `story/extract.py`, and `story/commands.py`:**
   - In `story/models.py`:
     - Remove `antigravity_json` and `claude_client` imports; import `to_claude_content` from `vibecut_agent.agent.claude_schema`.
     - Remove `claude_json()`, `claude_story()`, `antigravity_json_answer()`, and `antigravity_story()`.
     - Keep `gemini_json()`, `gemini_story()`, `claude_code_json_answer()`, and `claude_code_story()`.
   - In `story/commands.py`:
     - Update `PROVIDERS` to `{"gemini": "Gemini", "claude-code": "Claude (subscription)"}`.
     - Remove `"claude"` and `"antigravity"` branches in `_first_pass_extractor()` and `run()`.
   - In `story/extract.py`:
     - Update ` EXTRACT_CLAUDE_MODEL = "claude-sonnet-5-5"` (used with `claude_code_json_answer` at `effort="low"`) and `EXTRACT_GEMINI_MODEL = "gemini-2.5-flash"`.
8. **Update `src-python/vibecut_agent/review/critic.py`:**
   - Define `CRITIC_GEMINI_MODEL = "gemini-2.5-flash"` so `critic.py` continues to default to fast Gemini Flash (`model or CRITIC_GEMINI_MODEL`) even after `story/models.py` upgrades `GEMINI_DEFAULT_MODEL` to `"gemini-2.5-pro"`.
   - Update `WHO` to `{"gemini": "Gemini", "claude-code": "Claude (subscription)"}`.
   - Remove the `if provider_of(request) == "antigravity":` block (lines 270–276) and `elif provider == "antigravity":` (lines 284–286).
   - Remove `claude_json` import and the `elif provider == "claude":` branch; `run()` now dispatches strictly to `claude_code_json_answer` (for `"claude-code"`) or `gemini_json(..., model=model or CRITIC_GEMINI_MODEL)` (for `"gemini"`).
9. **Clean up `src-python/vibecut_agent/agent/attachments.py`:**
   - Remove `claude_tool_content()` and `without_tool_images_claude()` (which were only used by the deleted `claude_chat.py`), keeping `parse_images()`, `gemini_parts()`, `claude_blocks()` (used by `claude_code_chat.py`), `tool_images()`, `gemini_tool_parts()`, and `without_tool_images_gemini()`.

#### Step 1.3: Remove Antigravity & Anthropic API from Frontend (`src/`)
1. **Delete `src/components/settings/AntigravitySection.tsx` and `src/components/settings/AntigravitySection.test.tsx`.**
2. **Edit `src/types/system.ts`:**
   - Remove `anthropic: boolean;` and `anthropicSource: KeySource | null;` from `KeyStatus`.
   - Change `export type KeyProvider = "gemini" | "huggingface";`.
3. **Edit `src/types/agent.ts`:**
   - Change `export type ChatProvider = "gemini" | "claude-code";`.
   - Change `export type AiProvider = "gemini";`.
   - Change `export type ChoiceAccess = "gemini" | "claude-code";`.
   - Update `AiChoiceId` and `AI_CHOICES` to:
     ```ts
     export type AiChoiceId =
       | "gemini"
       | "gemini-pro"
       | "claude-code-opus-5-5"
       | "claude-code-sonnet-5-5";

     export const AI_CHOICES: readonly AiChoice[] = [
       { id: "gemini", label: "Gemini 2.5 Flash", provider: "gemini", chatProvider: "gemini", model: "gemini-2.5-flash" },
       { id: "gemini-pro", label: "Gemini 2.5 Pro", provider: "gemini", chatProvider: "gemini", model: "gemini-2.5-pro" },
       { id: "claude-code-opus-5-5", label: "Claude Opus 5.5 (subscription)", provider: "claude-code", chatProvider: "claude-code", model: "claude-opus-5-5" },
       { id: "claude-code-sonnet-5-5", label: "Claude Sonnet 5.5 (subscription)", provider: "claude-code", chatProvider: "claude-code", model: "claude-sonnet-5-5" },
     ];
     ```
   - Remove `AntigravityEffort`, `ANTIGRAVITY_EFFORTS`, `AntigravityStatus`, and `antigravityUsable`.
   - Update `export const KEY_ENV: Record<AiProvider, string> = { gemini: "GEMINI_API_KEY" };`.
4. **Edit `src/store/useAgentStore.ts`:**
   - Remove `antigravityEffort` and `setAntigravityEffort`.
   - In `normalizeAiChoice(value: unknown): AiChoiceId`, migrate legacy persisted values cleanly:
     - `"claude-opus-5-5"` -> `"claude-code-opus-5-5"`
     - `"claude-sonnet-5-5"` -> `"claude-code-sonnet-5-5"`
     - `"antigravity-gemini-4-argon"` -> `"gemini-pro"`
     - `"antigravity-gemini-3.8-flash"` -> `"gemini"`
5. **Edit `src/store/useSystemStore.ts` and `src/lib/ipc.ts`:**
   - Remove `getAntigravityStatus`, `setAntigravity`, `addAntigravityTools`, `removeAntigravityTools` from `src/lib/ipc.ts`.
   - Remove `antigravity`, `refreshAntigravity`, and `setAntigravity` from `src/store/useSystemStore.ts`.
6. **Edit `src/components/settings/SettingsPanel.tsx`, `ApiKeysSection.tsx`, `AgentModelSection.tsx`, and `src/components/about/AboutModal.tsx`:**
   - `SettingsPanel.tsx`: Remove `<AntigravitySection />` import and usage.
   - `ApiKeysSection.tsx`: Remove `anthropic` from `LABEL`, `KEY_ENV`, `SOURCE`, and remove `<KeyRow provider="anthropic" />`.
   - `AgentModelSection.tsx`: Remove `antigravity` status checks, `MISSING.anthropic`, `MISSING.antigravity`, and the `settings-effort-antigravity` `<select>` block. Update the Claude effort help text to refer to your Claude subscription.
   - `AboutModal.tsx`: Remove the `"Antigravity (Gemini subscription)"` and `"Anthropic API"` `<StatusRow>` entries and simplify `modelKeyReady`, `modelChecked`, `readyText`, `missingText`, and `modelDetail` to handle `"claude-code"` and `"gemini"`.
7. **Edit `src/lib/agent/availability.ts`, `controller.ts`, `chatHistory.ts`, `usage.ts`, `reviewTools.ts`, and `src/hooks/useAgent.ts`:**
   - `availability.ts`: Remove `antigravity` parameter and `"antigravity"` branch; check `choice.provider === "claude-code"` else `keys?.gemini`.
   - `controller.ts`: Update `PROVIDER_LABEL` to `{ gemini: "Gemini", "claude-code": "Claude (subscription)" }` and remove `antigravityEffort` from `jobPlan()`.
   - `chatHistory.ts`: Update `PROVIDERS` and `PROVIDER_LABELS` to `"gemini"` and `"claude-code"` (gracefully ignoring or mapping legacy `"claude"` / `"antigravity"` in saved chat files).
   - `usage.ts`: Update `turnCost()` so `claude-code` turns return `usage.costUsd` when reported (or fall back to `PRICES[choice.model]` token calculation if `costUsd` is absent), and add `"gemini-2.5-flash"` / `"gemini-2.5-pro"` token rates to `PRICES`.
   - `reviewTools.ts`: In `criticModel()`, when `wantsGemini && useSystemStore.getState().keys?.gemini`, return `{ provider: "gemini", model: "gemini-2.5-flash", label: "Gemini Flash", fellBack: false }`.
   - `useAgent.ts`: Remove `antigravity` subscription from `useEffect` dependencies.

---

### Phase 2: Gemini 2.5 Tiering, Thinking Budgets & Orchestrated Mode Support

#### Step 2.1: Upgrade `src-python/vibecut_agent/agent/gemini_chat.py`
1. Update `DEFAULT_MODEL = "gemini-2.5-flash"` and add `FALLBACK_MODEL = "gemini-flash-latest"`.
2. Add thinking budget mapping for Gemini 2.5 models:
   ```python
   GEMINI_THINKING_BUDGETS: dict[str, int] = {
       "low": 1024,
       "medium": 4096,
       "high": 16384,
   }
   ```
3. Update `run_chat_turn()` to accept `model: str | None = None` and `effort: str | None = None`:
   - Pass `resolved_model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL` to `GEMINI_STREAM_ENDPOINT.format(model=resolved_model)`.
   - When `resolved_model.startswith("gemini-2.5")` and `effort in GEMINI_THINKING_BUDGETS`, include `"thinkingConfig": {"thinkingBudget": GEMINI_THINKING_BUDGETS[effort]}` inside `generationConfig`.
   - If the initial stream request returns HTTP `404` for a `gemini-2.5-*` model, retry once with `FALLBACK_MODEL` (`"gemini-flash-latest"`, omitting `thinkingConfig`).

#### Step 2.2: Upgrade Story Editor Gemini Model in `src-python/vibecut_agent/story/models.py`
1. Set `GEMINI_DEFAULT_MODEL = "gemini-2.5-pro"`, `GEMINI_FALLBACK_MODEL = "gemini-flash-latest"`, and `GEMINI_TIMEOUT_SECONDS = 180`.
2. In `gemini_json()`, if `requests.post` returns HTTP `404` when using `gemini-2.5-*`, retry once with `GEMINI_FALLBACK_MODEL` so environments without `gemini-2.5-pro` access degrade gracefully.

---

### Phase 3: Local Sub-Agent Upgrades (`WhisperWorker`, `VlmWorker`, `GemmaValidator`, `VectorStore`, `Ingest`)

#### Step 3.1: Update `OrchestratorConfig` & Ollama Model Alias Resolution
1. In `src-python/vibecut_agent/config.py`:
   - Add `ValidatorMode = Literal["deterministic", "llm"]` and field `validator_mode: ValidatorMode = "deterministic"` on `OrchestratorConfig` (populated from `VIBECUT_VALIDATOR_MODE`, defaulting to `"deterministic"`).
   - Update default model names on `OrchestratorConfig`:
     - `whisper_model: str = "mlx-community/whisper-large-v3-turbo"`
     - `vlm_model: str = "qwen2.5vl:7b"`
     - `gemma_model: str = "gemma3:4b"`
   - Add `"VIBECUT_VALIDATOR_MODE"` to `ORCHESTRATOR_ENV` in `src-python/vibecut_agent/agent/claude_code_chat.py`.
2. In `src-python/vibecut_agent/workers/base.py`:
   - Add `MODEL_ALIASES` and `LocalLlmClient.resolve_available_model(self, preferred: str) -> str` so `"qwen2.5vl:7b"` <-> `"qwen2.5-vl:7b-instruct"`, `"gemma3:4b"` <-> `"gemma3:4b-it"`, and `"BAAI/bge-m3"` <-> `"bge-m3"` / `"nomic-embed-text"` / `"nomic-ai/nomic-embed-text-v1.5"` resolve seamlessly against `/api/tags`.
   - Add `keep_alive: str | int | None = None` to `LocalLlmClient.chat_json()`.

#### Step 3.2: Upgrade `WhisperWorker` & `transcribe/pipeline.py` to `large-v3-turbo`
1. In `src-python/vibecut_agent/workers/whisper_worker.py`:
   - Add `"large-v3-turbo"` to `TIERS`:
     ```python
     "large-v3-turbo": {
         "mlx-whisper": "mlx-community/whisper-large-v3-turbo",
         "faster-whisper": "deepdml/faster-whisper-large-v3-turbo-ct2",
         "whisper.cpp": "ggml-large-v3-turbo.bin",
     },
     ```
   - Check `"large-v3-turbo"` before `"large-v3"` in `_tier_from_model()`.
   - Cache `WhisperModel` instances in `_FASTER_WHISPER_CACHE` inside `faster_whisper_backend()` instead of deleting the model after every file.
2. In `src-python/vibecut_agent/transcribe/pipeline.py`:
   - Add `"large-v3-turbo": "mlx-community/whisper-large-v3-turbo"` to `WHISPER_MODELS` and set `DEFAULT_MODEL = "large-v3-turbo"`.
3. In `ORCHESTRATOR_SPEC.md` and `src-python/vibecut_agent/orchestrator/schemas.py`:
   - Add `"large-v3-turbo"` to the `transcribe_and_align` `model_tier` enum (`["tiny", "small", "medium", "large-v3-turbo", "large-v3"]`).

#### Step 3.3: Switch `GemmaValidator` to Deterministic Default + Cut-Point Context in `"llm"` Mode
1. In `src-python/vibecut_agent/workers/gemma_validator.py`:
   - Add `validator_mode: str = "deterministic"` to `GemmaValidator.__init__()` (passed from `OrchestratorToolBus` via `config.validator_mode`).
   - When `self.validator_mode == "deterministic"`, skip `self._review()` so `validate_and_translate()` returns immediately after `compile_to_nle_commands()` with `validator_model="deterministic"`.
   - When `self.validator_mode == "llm"`, resolve the model via `self._client.resolve_available_model(self.model_name)` and run `self._review()`.

#### Step 3.4: Upgrade `VlmWorker` with 3-Frame Temporal Contact Strip & Batch Keep-Alive
1. In `src-python/vibecut_agent/core/ffmpeg_ops.py`:
   - Enhance `extract_keyframes_for_vlm()` (or add `extract_shot_strip_for_vlm`) so each shot past `0.6s` duration extracts a 3-frame horizontal strip (`15%`, `50%`, `85%` of `[start_s, end_s]` via FFmpeg `select` + `tile=3x1`), giving the VLM `[START | MID | END]` temporal context in one JPEG.
2. In `src-python/vibecut_agent/workers/vlm_worker.py`:
   - Update `_PROMPT` to instruct the VLM to read the 3-frame strip from left (shot start) to right (shot end) when classifying `camera_movement` (`PAN_LEFT`, `PAN_RIGHT`, `DOLLY_IN`, `DOLLY_OUT`, `STATIC`, `RACK_FOCUS`).
   - Pass `keep_alive="10m"` to `self._client.chat_json()` so Ollama keeps `qwen2.5vl:7b` warm across all shots in an ingest.

#### Step 3.5: Stage-Batched Multi-File Ingest (`workers/ingest_pipeline.py`) & `GpuLock` in `broll/vision_energy.py`
1. In `src-python/vibecut_agent/workers/ingest_pipeline.py`:
   - Refactor `Ingest.run()` so multi-file ingests (`len(paths) > 1`) execute all `transcribe` stages first, then all `vision` stages, then all `index` stages across the file list, preventing Ollama from evicting and reloading `qwen2.5vl:7b` and `bge-m3`/`nomic-embed-text` on every file.
2. In `src-python/vibecut_agent/broll/vision_energy.py`:
   - Acquire `GpuLock(OrchestratorConfig.from_env().vector_index_dir)` around PyTorch MPS `SigLIP 2` frame embedding so concurrent `broll-analyze` and `ingest-index` runs never collide on Apple Silicon unified memory.

---

### Phase 4: Verification & Smoke Tests

Run all verification suites below in order and confirm 100% pass rate:

```bash
# 1. Sync lockfile after removing `anthropic` dependency
uv lock

# 2. Python lint, format & strict mypy
uvx ruff check src-python/ tests/
uvx ruff format --check src-python/ tests/
uv run mypy src-python/ tests/

# 3. Python unit & integration tests (Direct + Orchestrated + Local Workers)
uv run pytest tests/ -v
uv run --isolated --extra orchestrator --group dev pytest \
  tests/core/ \
  tests/workers/ \
  tests/orchestrator/ \
  tests/nle/test_bridge_runner.py \
  tests/test_config.py \
  tests/test_mcp_server.py -v

# 4. Frontend ESLint, TypeScript & Vitest
npm run lint
npx tsc --noEmit
npm run test -- --run

# 5. Rust Tauri crate tests (sidecar, secrets, claude_code, mcp_bridge)
cargo test --manifest-path src-tauri/Cargo.toml
```

### Phase 5: Checklist of Test Updates Required During Execution
- **Delete:** `tests/agent/test_antigravity_chat.py`, `tests/agent/test_claude_chat.py`, `tests/agent/claude_fakes.py`, `src/components/settings/AntigravitySection.test.tsx`.
- **Update:**
  - `tests/agent/test_tool_images.py`: Remove imports of deleted `tests.agent.claude_fakes`, `tests.agent.test_claude_chat`, and `without_tool_images_claude`; keep the `tool_images` validation and `gemini_chat` tool-image tests.
  - `tests/agent/test_chat_session.py`: Remove `"claude"` and `"antigravity"` provider cases; test `"gemini"` (both `direct` and `orchestrated`) and `"claude-code"`.
  - `tests/agent/test_titles.py`: Test `"gemini"` (`gemini-2.5-flash`) and `"claude-code"` (`claude-sonnet-5-5` at `effort="low"`).
  - `tests/story/test_commands.py` & `tests/story/test_first_pass.py`: Remove `"claude"` API and `"antigravity"` test cases; verify `"gemini"` (`gemini-2.5-pro` / `gemini-2.5-flash`) and `"claude-code"`.
  - `tests/review/test_critic.py`: Remove `"claude"` API and `"antigravity"` test cases; verify `"gemini"` (`gemini-2.5-flash` default) and `"claude-code"`.
  - `tests/orchestrator/test_supervisor.py`, `tests/orchestrator/test_dual_mode.py`, and `tests/test_config.py`: Drive `resolve_chat_turn_runner("gemini", config)` and `make_orchestrated_turn_runner` through `gemini_chat.run_chat_turn` (faked HTTP SSE stream) and `claude_code_chat` (`Orchestration` in `mcp_server.py`).
  - `src/components/settings/ApiKeysSection.test.tsx`, `src/components/settings/SettingsPanel.test.tsx`, `src/components/about/AboutModal.test.tsx`, `src/components/usage/UsageMeter.test.tsx`, `src/lib/ipc.test.ts`, `src/lib/agent/availability.test.ts`, `src/lib/agent/controller.test.ts`, `src/lib/agent/reviewTools.test.ts`, `src/lib/agent/storyTools.test.ts`, `src/lib/agent/rewind.test.ts`, `src/lib/agent/usage.test.ts`, `src/store/useAgentStore.test.ts`, `src/store/useSystemStore.test.ts`, `src/store/useUsageStore.test.ts`: Update `KeyStatus` fixtures (removing `anthropic` and `anthropicSource`), `ChatProvider` fixtures (replacing `"claude"` with `"gemini"` or `"claude-code"`), and `AiChoiceId` values (using `"claude-code-opus-5-5"`, `"claude-code-sonnet-5-5"`, `"gemini"`, `"gemini-pro"`).
