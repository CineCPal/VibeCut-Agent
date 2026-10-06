# AGENTS.md — Shared Engineering Specification

This is the canonical, agent-agnostic spec for the engineering workspace: stack defaults, design tokens, privacy/security policy, build/test commands, architecture rules, and testing standards. Both `CLAUDE.md` (Claude, Implementation Lead) and `GEMINI.md` (Gemini, Systems Architect) treat this file as the shared contract — they add role-specific behavior on top of it and never restate or contradict what's defined here. If a stack default, token, or policy needs to change, change it here first.

---

## 1. System Overview & Mandate

This workspace builds modular, local-first applications, interactive games, and low-latency trading systems for a Freelance Video Producer, Game Developer, and Quant Trader. Every app is an independent repo under the user's personal GitHub account (`CineCPal`) — this document defines shared conventions across those repos to ensure personal and work projects remain strictly separated.

- **Privacy & Connectivity Posture:** Local-first by default, prioritizing free and open-source tools. Network access and external cloud APIs (e.g., LLMs, trading exchanges, game leaderboards) are permitted when explicitly required for the app's function, but must be disclosed and securely handled.
- **Form Factor:** Dedicated native desktop windows — Tauri v2 (primary), PyQt6 (primary for heavier Python workloads), local Node tools, or native game windows.

---

## 2. Stack Defaults

Pick the stack based on what the app actually needs.

### Tauri v2 desktop apps (primary pattern for tools & games)
- **React 19 + Vite 7 + Tailwind CSS v4** (`@theme` blocks in CSS) **+ Zustand v5** for state.
- For web-based games, embed HTML5 Canvas or Phaser.js within the React frontend.
- Standard `src/` shape: `components/`, `hooks/`, `lib/`, `store/`, `styles/`, `types/`, `assets/`; Rust side: `src-tauri/src/{main.rs, lib.rs, commands.rs, state.rs}`.

### Python / PyQt6 (Media Pipelines & ML)
- Layout: `src/{ui, core|pipeline, workers|ml, utils}/`, `main.py`, `config.py`.
- Dependencies pinned via `uv` in `pyproject.toml`.

### Quantitative Trading Systems
- **Core Engine:** Python (Asyncio, CCXT, WebSockets) for strategy deployment, or Rust/C++ for low-latency execution backends.
- **Storage:** Time-series databases (TimescaleDB, InfluxDB) or local SQLite/PostgreSQL for trade logs and configuration.
- **Dashboard:** React/Tailwind frontend or lightweight Streamlit/Grafana monitoring.

### Node.js Local Tools (Express + tsx)
- Use for local servers, RAG/chat utilities, or simple API backends.

---

## 3. Global Design Tokens & UI Specs

All frontends maintain a cohesive dark-mode aesthetic, optimized for multi-monitor setups and long-hour usage:

- **Primary:** Athletic Blue (`#002244`)
- **Primary (light):** Athletic Blue Light (`#4a90d9`), for text and icons on dark surfaces where `#002244` is too dark to read (5.2:1 on Surface). Use `#002244` for fills only.
- **Accent:** Warm Grey (`#99928A`)
- **Secondary / Neutral:** Cool Grey (`#72808A`)
- **Background (dark mode):** Canvas `#0D1117`, Surface `#161B22`, Border `#30363D`
- **Trading Status Colors:** Profit/Long (`#00C853`), Loss/Short (`#FF5252`), Warning (`#FFB300`)
- **Typography:** System sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`). Use clean monospace (`Fira Code`, `JetBrains Mono`) for quantitative data and logs.

Tailwind v4 token block:
```css
@theme {
  --color-athletic-blue: #002244;
  --color-athletic-blue-light: #4a90d9;
  --color-warm-grey: #99928a;
  --color-cool-grey: #72808a;
  --color-canvas: #0d1117;
  --color-surface: #161b22;
  --color-border: #30363d;
  --color-profit: #00c853;
  --color-loss: #ff5252;
  --color-warning: #ffb300;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Fira Code", "JetBrains Mono", monospace;
}
```

---

## 4. Security, Privacy & API Policy

**Local-first, open-source preferred.** Applications should minimize reliance on paid cloud ecosystems.
- **API Keys & Secrets:** Never hardcode API keys, secrets, or passphrases. Require environment variables (`.env`) or secure secrets managers. Do not log raw API keys or dynamic auth tokens. Trading keys must enforce read/trade permissions only; disable withdrawals entirely.
- **Cloud Services:** Authorized for required external integrations (e.g., CCXT for crypto exchanges, OpenAI/Gemini for LLM features, cloud leaderboards). Always prefer a local fallback (e.g., local Ollama, Whisper.cpp) where feasible.
- **Data Privacy:** User data, project files, and game saves should be stored locally (SQLite or encrypted JSON) unless explicitly configured by the user to sync off-machine.

---

## 5. Environment Prerequisites

- `ffmpeg` (with `videotoolbox` / `nvenc`), `exiftool`, `magick`, `tesseract` for media/OCR.
- Node.js 22.x LTS.
- Python (>= 3.11) configured via `uv`.
- Rust (`cargo` stable).

---

## 6. Build, Lint & Test Commands

### Tauri v2 Stack
```bash
npm install
npm run tauri dev
npm run lint && npx tsc --noEmit
npm run test
```

### Python Suite (uv / Media / Trading)
```bash
uv sync
uv run python src/main.py
uvx ruff check src/ && uvx ruff format src/
uv run mypy src/
uv run pytest tests/ -v --cov=src
```

---

## 7. "About This App" Modal

Every app must ship an accessible "About This App" modal or configuration panel:
- App name + version + description.
- Binary discovery status (`ffmpeg`, etc.) if used.
- Hardware acceleration status.
- Storage paths.
- Network/API status (e.g., "Exchange WebSockets Active", "Gemini API Connected").

---

## 8. Domain Architecture Rules

### Media Processing
1. **Memory Safety:** Multi-gigabyte media must NEVER be read entirely into RAM. Use streaming chunks or direct file descriptor pipes via FFmpeg.
2. **Execution:** Media commands must run asynchronously. The UI thread must NEVER block.
3. **Feedback:** Require deterministic progress indicators (percentage, ETA) for long tasks.

### Game Development
1. **Performance:** Optimize local assets (sprites, sounds) for 60 FPS performance without heavy memory overhead.
2. **State & Saving:** Use local SQLite or encrypted JSON for player profiles, progress, and scores.
3. **Fail-safes:** Graceful error handling during gameplay; no cryptic terminal crashes. 

### Quantitative Trading
1. **Risk Management:** Always implement automated circuit breakers (max drawdown, hard stop-loss, position size caps, order-rate throttling).
2. **Execution:** Prioritize low latency, non-blocking I/O, and async event loops for WebSockets.
3. **State Recovery:** Implement strict state management to recover safely from crashes and re-sync exchange state on restart.
4. **Simulation First:** Provide mock/paper trading capabilities for every strategy prior to live capital deployment.

---

## 9. Testing Standards
- Tauri apps: vitest coverage for Zustand stores and IPC wrappers.
- Python/Trading apps: `pytest` coverage, particularly testing risk limits and strategy logic.
- Rust crates: `cargo test` for core execution logic.

## 10. Code Style & Output Standards
- **No Truncations:** Write complete, copy-pasteable files. Do not use placeholder comments (`// ... rest of implementation`).
