# VibeCut Agent

VibeCut Agent is a standalone AI video editing assistant for Premiere Pro and DaVinci Resolve. It separates the agentic chat and B-roll analyzer from the main VibeCut application, allowing you to use the AI capabilities alongside your existing NLE workflow.

## Features
- **Local-first Architecture:** Operates with a Tauri v2 frontend and a Rust/Python backend.
- **NLE Integration:** Connects directly to Premiere Pro and DaVinci Resolve via their plugin architectures.
- **AI Agent:** Supports Gemini and Claude models for multi-step timeline assembly and edits, with API keys or, for Claude, your own signed-in Claude Code (your Claude subscription, no key).
- **Outside control:** a Claude Code session (including one driven from your phone through Remote Control) can call the agent's tools over a local MCP bridge.
- **B-Roll Library:** Searches and browses Spyglass's index of your archive (Rough Cut Studio Suite - Blair Themed), scopes the agent's B-roll searches, previews shots in the editor's source viewer, and imports, places or drags clips into Premiere Pro or DaVinci Resolve.
- **B-Roll Analyzer:** Scans a folder and rates its B-roll, placing the best stretches on the timeline.

## Development Setup
See `QUICKSTART.md` for full environment setup and execution commands.
