# VibeCut Agent

VibeCut Agent is a standalone AI video editing assistant for Premiere Pro and DaVinci Resolve. It separates the agentic chat and B-roll analyzer from the main VibeCut application, allowing you to use the AI capabilities alongside your existing NLE workflow.

## Features
- **Local-first Architecture:** Operates with a Tauri v2 frontend and a Rust/Python backend.
- **NLE Integration:** Connects directly to Premiere Pro and DaVinci Resolve via their plugin architectures.
- **AI Agent:** Multi-step timeline assembly and edits with Gemini 3.8 Flash or Gemini 3.1 Pro (your Gemini API key) or with Claude Opus or Sonnet through your own signed-in Claude Code (your Claude subscription, no key). Chat titles, and optionally edit reviews, run on local models on your Mac when they're there.
- **Outside control:** a Claude Code session (including one driven from your phone through Remote Control) can call the agent's tools over a local MCP bridge.
- **B-Roll Library:** Searches and browses Spyglass's index of your archive (Rough Cut Studio Suite - Blair Themed), scopes the agent's B-roll searches, previews shots in the editor's source viewer, and imports, places or drags clips into Premiere Pro or DaVinci Resolve.
- **B-Roll Analyzer:** Scans a folder and rates its B-roll, placing the best stretches on the timeline.
- **Production Kanban Board:** each editor project has a board (Board tab, ⌘2) shared by you, the editing agent, the supervising editor and the background bots. The agent plans multi-step edits as dependency-linked cards, one per sub-agent (transcription, vision, B-roll, cutting, audio, colour), and runs them a wave at a time. Cards follow their jobs, held reviews and reverts by themselves. You can seed cards from QC checks or client notes, mirror the board on the timeline as colour-coded markers, and point at a card with `@kb_3`.
- **Inside the editors:** a dockable VibeCut Agent panel in Premiere Pro (Window → Extensions → VibeCut Agent) and a Workflow Integration plugin in DaVinci Resolve Studio (Workspace → Workflow Integrations → VibeCut Agent), each with Chat · Board · Library · Analyze · History tabs, the window's usage tracker and status line, and a Window button for the app's floating window. Both run alongside the menu-bar app and show the same conversation; install or update them from Settings → Editors.

## Development Setup
See `QUICKSTART.md` for full environment setup and execution commands.
