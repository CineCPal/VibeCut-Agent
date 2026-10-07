# Quickstart

## Prerequisites
- Node.js 22.x LTS or higher
- Python >= 3.11
- Rust (`cargo` stable)
- `ffmpeg`, `ffprobe`, `exiftool` available on PATH or Homebrew `/opt/homebrew/bin`
- `uv` Python package manager

## Initial Setup
1. **Frontend Dependencies:**
   ```bash
   npm install
   ```

2. **Python Backend Setup:**
   ```bash
   uv sync
   ```

3. **API keys** (only the model you'll use needs one; the "(subscription)" models need none, see **Claude without an API key** below):
   - **Any build:** open Settings → API keys, paste the key and press Save. It's stored in your macOS login Keychain (service `com.cj.vibecutagent`) and never shown again. Remove deletes it.
   - **Dev builds:** you can also create a `.env` at the root; it's git-ignored and takes precedence over the Keychain:
     ```env
     GEMINI_API_KEY=your_key_here
     ANTHROPIC_API_KEY=your_key_here
     ```
   - **Release builds opened from Finder** don't see `.env` or your shell variables, so use Settings.

## Install the App (the easy way to launch it)

```bash
npm run install-app
```
This builds VibeCut Agent and installs it as **~/Applications/VibeCut Agent.app**, then opens it. The first build takes a few minutes.

- **Open it** from Spotlight (⌘Space, "VibeCut Agent"), Launchpad or the Dock. Opened by hand, it shows its window. Opening it again while it runs brings the window back.
- **Open at login:** Settings → Window → Open at login starts it in the menu bar when you log in, without a window. Only the installed app can do this.
- **Its first launch** sets up Python in its app data folder, which takes about a minute.
- **Signing:** the script signs with your first "Apple Development" identity (or `VIBECUT_SIGNING_IDENTITY`). macOS then sees every new build as the same app, so the Keychain asks only once ("Always Allow") before the app reads its keys. Without an identity it signs ad hoc and warns that the Keychain will ask after each update.
- **Keys:** it doesn't read the repo's `.env`. Put the API keys in Settings → API keys, which saves them in the Keychain.
- **Updating:** after pulling changes, run `npm run install-app` again. It quits the installed copy, replaces it and opens the new one.
- **Don't run it alongside `npm run tauri dev`:** two copies would both watch the editors. The script won't open the app while a dev build runs.

## Running the App

**Start the Desktop App (Tauri dev mode):**
```bash
npm run tauri dev
```
VibeCut Agent is a menu-bar app. It launches with **no window and no Dock icon**. Click its icon in the macOS menu bar to open the Agent panel, the B-Roll Analyzer, Settings or About. Closing the window hides it; use **Quit VibeCut Agent** in the menu to exit.

**Over full-screen editors:** the window stays on top of other apps, and shows over Premiere Pro or DaVinci Resolve in full screen (it follows you to every Space). Turn it off with the pin in the header, Settings → Window, or **Keep on Top of Editors** in the menu-bar menu.

In the window: ⌘1 opens Agent, ⌘2 opens B-Roll, ⌘, opens Settings, ⌘I opens About, and Esc closes a dialog.

At launch the app also starts the Python agent sidecar with `uv run --locked` (run `uv sync` first). Settings → Agent sidecar shows whether it's running, and has a Restart button. To use a different `uv` binary or Python project, set `VIBECUT_UV` or `VIBECUT_AGENT_PYTHON_ROOT`.

**Connect the editors** (Settings → Editors):
- **Premiere Pro:**
  1. Press **Install panel**, then restart Premiere. This copies VibeCut Agent's own CEP panel, `com.vibecutagent.connect`, into `~/Library/Application Support/Adobe/CEP/extensions/`. It runs alongside VibeCut's panel without touching it.
  2. Unsigned panels need CEP's PlayerDebugMode: `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (the app only reads this setting).
- **DaVinci Resolve:** needs Resolve Studio 21.1 or later, with Preferences → System → General → "External scripting using" set to **Local**. Nothing to install.
- Each editor is watched continuously. Starting, quitting or restarting it, or switching projects, updates the Pr/Re lights within about 2 s. **Reconnect** restarts a watcher immediately.

**Chat with the agent:** add a key in Settings → API keys (or `.env` in dev; see above) and pick the model in Settings.
- The chat box unlocks once the sidecar is running and that model's key is set.
- Each message includes a snapshot of the timeline open in Premiere or Resolve.
- **What it can do:** read timelines, move the playhead, work with markers, and find B-roll in your Spyglass archive (`find_broll`, scoped to the Library's ticked folders). Its matches show in the Library.
- **What's said:** it transcribes footage on this Mac (Whisper, Apple Silicon; the first run downloads the model and about 200 MB of packages) and saves each transcript next to its file. It then reads, searches and cuts by it: whole lines, a speaker's lines (e.g. the interviewer's questions), filler words and dead air. Those cuts go into a **draft**: a bar above the message box shows it, and **Send** builds a new sequence (like "Interview (VibeCut 1)") while yours stays untouched. **Discard** drops it.
- **Telling speakers apart** is optional: add a free Hugging Face token in Settings → API keys, and accept the pyannote speaker-diarization licences on huggingface.co.
- **Your project:** it sees the Project panel / Media Pool (each clip gets a short id like `p3`), can search it, and can make a new sequence, copy one, switch, rename and select. It builds a new sequence from your footage by creating it and placing clips by file path. It switches to one of *your* sequences only when you name it, and renames only the ones it made.
- **It can also edit the open timeline directly:** add clips from files, delete, switch on or off, levels, fades, split, trim, slip, move, nest, and duck music under dialogue.
- **Backup and Revert:** the first edit of each request makes a backup copy ("Main (before VibeCut 1)"), and **Revert n edits** in the chat header undoes the latest request. The edit log is saved, so Revert still works after a restart: the button then says "(earlier session)", and clips you changed since are left alone. The backup copy is still there as a second way back.
- **Replies** appear as they're written, on every model. What the agent says before using a tool stays as its own message.
- **Copy, Retry, Edit:** hover a message (or Tab to it) for **Copy**. **Retry** under the last answer sends your last message again from where it started; **Edit** (the pencil on your last message, or **↑** in an empty message box) changes it and sends it again (Esc cancels). If that request edited the timeline, both revert its edits first ("Revert 2 edits & retry"), and stop if any can't be undone.
- **Past chats:** the chat you had open comes back when the app restarts. **History** in the chat header (or **⌘Y**) lists the last 30. Type to search their names and what was said; use ↑↓ and Enter to open one, **F2** (or the pencil) to rename it, and Tab, then Delete twice to remove one. After a chat's first answer, its model gives it a short name (Settings → Chat → "Name chats with the model"; one small call per new chat). A name you give it always stays. A reopened chat carries on where it left off on the same model. On another model, the model starts without its memory of the earlier messages, which stay on screen. Chats and the edit log are saved only on this Mac, in `~/Library/Application Support/com.cj.vibecutagent/history/` (About → Storage).
- **Premiere:** these need panel 0.7.0 or later (Settings → Editors → Update panel, then restart Premiere).

**Claude without an API key** (Settings → Claude subscription): the **"Claude Opus 5.5 (subscription)"** and **"Claude Sonnet 5.5 (subscription)"** models run your own Claude Code, signed in with your Claude account, so turns use your Claude plan instead of an API key.
- **Needs:** Claude Code installed and signed in (run `claude` once in Terminal and sign in). The app looks in `~/.local/bin`, `~/.claude/local`, Homebrew and PATH; **Choose…** picks the program yourself.
- **Profiles:** if you switch Claude Code accounts with `CLAUDE_CONFIG_DIR` (or a shell function that sets it), choose that folder as the **Profile folder**. The app never runs your shell, so it can't pick one by itself.
- **Check** runs `claude auth status` and shows who's signed in.
- Claude Code runs with only VibeCut's editing tools: no shell, files or web, none of your hooks, and no permission prompts. Its tool calls come back to the app through the MCP bridge (below).
- Usage counts against your Claude plan's limits. For your own use on this Mac only: don't hand a build to someone else with your login.
- The **Story Editor** runs on it too, with no key.
- **Long footage** (over 2,000 transcript lines, about 3–4 hours of interviews): the Story Editor first reads every line in parts and shortlists the strongest moments, then cuts the story from them. Settings → Agent model → **first read** sets which model does that first pass: the agent's own provider (Claude Sonnet on the subscription), or Gemini Flash, which is faster and spares your Claude plan but needs a Gemini key and sends the transcripts to Google. Only text is sent, never audio.

**Remote edits with Claude Code** (Settings → Outside control): a Claude Code session you start, on this Mac or driven from your phone, can use the agent's tools on the open timeline.
1. Turn on **Allow Claude Code to edit through VibeCut Agent** (off by default).
2. Press **Copy remote session command** and run it in Terminal on this Mac. It starts `claude --remote-control vibecut` with only VibeCut's editing tools: no shell, file or web tools, no other MCP servers, and VibeCut's tools allowed without asking. It needs no setup in Claude Code.
3. Open the session from claude.ai or the Claude app on your phone.
4. Ask it to edit: "read the timeline, then mark every place the speaker says 'bakery'". It calls `get_instructions` and `get_editor_context` first.
- **Your other Claude Code sessions:** **Copy Claude Code command** adds VibeCut to all of them (`claude mcp add --scope user …`). Those sessions keep their usual tools, so they can also change files on this Mac, VibeCut's included; your permission prompts guard them. The app never edits Claude Code's settings itself.
- **The Mac must stay awake**, with VibeCut Agent running and Premiere (with its panel) or Resolve connected.
- **Outside edits** are noted in the chat as "Claude Code (outside): …", backed up and grouped: one **Revert n edits** undoes a run (a run ends after 2 minutes without a call).
- **One driver at a time:** outside edits wait for an in-app chat turn to finish, and the message box waits while an outside call runs.
- **How it connects:** Claude Code starts `python -m vibecut_agent mcp`, which passes each call to the app through files in `~/Library/Application Support/VibeCut Agent/host-bridge/mcp/` (no network port).

**B-roll in Premiere** (the way to drag clips into Premiere): after Settings → Editors → **Update panel** and a Premiere restart, open **Window → Extensions → VibeCut Agent B-roll** and dock it.
- It's the B-roll Library inside Premiere. **Drag a card** into the Project panel or onto the timeline (you'll see Premiere's insert marker), and **double-click a card** to open the shot in the Source monitor with In/Out marked.
- Search, folders, Pool, Source, Import and Place work as in the app. VibeCut Agent must be running (it lives in the menu bar); the panel connects to it by itself.

**B-roll Library** (B-Roll tab → **Library**): your archive as Spyglass indexed it (Rough Cut Studio Suite - Blair Themed).
- **Choose the index:** the app reads `VIBECUT_SPYGLASS_INDEX` (dev shells; set in `~/.zshenv` here), else the index chosen in **Settings → B-roll Library → Choose index…**, else Spyglass's own `~/Library/Application Support/edu.blair.spyglass/`. A release build opened from Finder needs the Settings choice to use the Blair Themed index. The file is only ever read.
- **Folders:** tick folders to set the scope. Searches, browsing and the agent's `find_broll` use it (the whole archive when none are ticked).
- **Search:** type a description and press Enter, or leave it empty to browse. The first search installs the content-aware packages (about 2 GB) and loads SigLIP 2.
- **On a shot:**
  - **Double-click the thumbnail** (or press **Source**/Space) to open it in Premiere's Source monitor or Resolve's source viewer, with In and Out marked.
  - **Import** puts it in the "VibeCut B-roll" bin. Revert doesn't undo imports.
  - **Place** puts its picture at the playhead (revertible).
  - **Pool** sets it aside.
  - **Drag the card** out of the app window (the whole file). For Premiere's timeline, use the docked VibeCut Agent B-roll panel instead (see above).
- **Premiere:** Source and Import need panel 0.4.0 or later. Press Settings → Editors → Update panel, then restart Premiere.

**B-roll Folder** (B-Roll tab → **Folder**): choose a folder and press **Analyze folder**.
- Clips are ranked by sharpness, exposure and stability, with the best few seconds of each.
- **Place** (the list-plus icon) puts a pick's best stretch at the playhead of the open timeline. It's revertible like any agent edit.
- **Content-aware scoring** adds energy, brief matching, near-duplicate detection and text search. Its first run installs about 2 GB of Python packages (`uv sync --extra energy` does the same ahead of time) and downloads the SigLIP 2 weights from Hugging Face once.

**Try transcription by hand:**
```bash
echo '{"videos": ["/absolute/path/interview.mp4"], "model": "mlx-community/whisper-small-mlx", "diarize": false, "format": "txt"}' | PYTHONPATH=src-python uv run --extra transcribe python -u -m vibecut_agent transcribe
```

**Try a Spyglass search by hand** (clip ids come from the index's `clips` table):
```bash
echo '{"clipIds": [1, 2, 3], "queries": [{"id": "q", "text": "players on a field"}]}' | PYTHONPATH=src-python uv run --extra energy python -u -m vibecut_agent broll-spyglass
```

**Try a watcher by hand:**
```bash
printf '{}\n{"type":"call","id":"c1","command":"status","args":{}}\n{"type":"end_session"}\n' | PYTHONPATH=src-python uv run python -u -m vibecut_agent premiere-watch
```

**Try the B-roll analyzer by hand:**
```bash
echo '{"folder": "/absolute/path/to/clips"}' | PYTHONPATH=src-python uv run python -u -m vibecut_agent broll-analyze
```

**Try the MCP server by hand** (needs the app running; lists the agent's tools):
```bash
PYTHONPATH=src-python uv run --extra mcp python -m vibecut_agent mcp
```
Easier: `claude mcp add` it (Settings → Outside control → Copy Claude Code command), then `/mcp` in Claude Code shows its tools.

**Try the sidecar by hand** (the same protocol Rust uses):
```bash
printf '{}\n{"type":"ping","id":1}\n{"type":"end_session"}\n' | PYTHONPATH=src-python uv run python -u -m vibecut_agent session
```

**Release build:** `npm run install-app` (see "Install the App"), or `npx tauri build --bundles app` to build without installing. The `.app` bundles the sidecar sources. It needs `uv` installed on the machine, and keeps its Python environment in the app data folder.

**Run Tests:**
```bash
# Frontend
npm run test

# Rust
cd src-tauri && cargo test && cargo clippy --all-targets

# Python Sidecar
uv run pytest tests/ -v --cov=src-python
```

**Lint & Formatting:**
```bash
# Frontend
npm run lint && npx tsc --noEmit

# Python
uvx ruff check src-python/ && uvx ruff format src-python/
uv run mypy src-python/
```

