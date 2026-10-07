/** The MCP bridge (PLAN.md, Phase 7a; src-tauri/src/mcp_bridge.rs). */

/** The caller of a request that didn't come from the app's own chat (a Claude Code session, 7d). */
export const OUTSIDE_CALLER = "outside";

/** One request from the shim, as Rust checked and rebuilt it. `caller` is a chat job id or "outside". */
export interface McpRequest {
  id: string;
  caller: string;
  kind: "list_tools" | "call_tool";
  name?: string;
  args?: Record<string, unknown>;
}

/** The answer written back for the shim (`id` is added by Rust). */
export type McpReply = { ok: true; result: unknown; summary?: string } | { ok: false; error: string };

export interface McpStatus {
  outsideAllowed: boolean;
  /** When the last outside request arrived this run (ms since the epoch). */
  lastOutsideAt: number | null;
  folder: string;
}

/** How an MCP client starts the shim. */
export interface ShimLaunch {
  program: string;
  args: string[];
  env: [string, string][];
}

export interface McpClientSetup {
  launch: ShimLaunch;
  /** The `claude mcp add …` line, ready to paste into Terminal: VibeCut in every Claude Code session. */
  claudeAdd: string;
  /** A Remote Control session that can only edit through VibeCut (no shell, files or web). */
  remoteStart: string;
}
