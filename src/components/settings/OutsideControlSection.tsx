import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { getMcpClientSetup, setMcpOutsideAllowed } from "../../lib/ipc";
import { useMcpStore } from "../../store/useMcpStore";
import type { McpClientSetup } from "../../types/mcp";
import { Section } from "../common/Section";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/**
 * Settings > Outside control (PLAN.md, Phase 7a and 7d): lets a Claude Code session the user started
 * (on this Mac, or driven from a phone through Claude Code's Remote Control) call the agent's tools
 * through the MCP bridge. Off by default; Rust saves the choice. The app never edits Claude Code's
 * config: the user runs a copied line. The recommended one (`remoteStart`, Phase 7f) starts a Remote
 * Control session locked to VibeCut's tools; `claude mcp add` adds VibeCut to their full-tool sessions.
 */
export function OutsideControlSection() {
  const allowed = useMcpStore((s) => s.outsideAllowed);
  const lastOutsideAt = useMcpStore((s) => s.lastOutsideAt);
  const running = useMcpStore((s) => s.outsideRunning);
  const [setup, setSetup] = useState<McpClientSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"remote" | "add" | null>(null);

  useEffect(() => {
    getMcpClientSetup()
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);

  const toggle = async (on: boolean) => {
    setError(null);
    try {
      const status = await setMcpOutsideAllowed(on);
      useMcpStore.getState().setStatus(status.outsideAllowed, status.lastOutsideAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (which: "remote" | "add") => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(which === "remote" ? setup.remoteStart : setup.claudeAdd);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't copy. Select the command below and copy it instead.");
    }
  };

  const activity = running > 0 ? "Claude Code is calling a tool now." : lastOutsideAt ? `Last call ${ago(lastOutsideAt, Date.now())}.` : "No outside calls since the app started.";

  return (
    <Section title="Outside control">
      <label className="flex items-start gap-2 text-xs text-white">
        <input
          type="checkbox"
          className="mt-0.5 accent-athletic-blue-light"
          checked={allowed ?? false}
          disabled={allowed === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          Allow Claude Code to edit through VibeCut Agent
          <span className="block text-[11px] text-cool-grey">
            A Claude Code session you start can use the agent's tools on the open timeline, including from your phone with{" "}
            <code className="font-mono">claude --remote-control</code>. Its edits are backed up and grouped, so Revert undoes a run.
          </span>
        </span>
      </label>
      {allowed ? <p className="mt-1 text-[11px] text-cool-grey">{activity}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {error}
        </p>
      ) : null}
      {setup ? (
        <>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-white">Remote editing session (recommended)</p>
            <button type="button" className={linkButton} onClick={() => void copy("remote")}>
              <Copy size={12} aria-hidden="true" />
              {copied === "remote" ? "Copied" : "Copy remote session command"}
            </button>
          </div>
          <p className="text-[11px] text-cool-grey">
            Starts Claude Code with Remote Control and only VibeCut&rsquo;s editing tools: no shell, files or web, and no other MCP servers. Run it in Terminal on
            this Mac, then open the session from your phone.
          </p>
          <pre className="mt-0.5 max-h-24 select-all overflow-y-auto whitespace-pre-wrap break-all rounded border border-border bg-canvas p-1.5 font-mono text-[10px] text-white">
            {setup.remoteStart}
          </pre>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-white">Add VibeCut to all your Claude Code sessions</p>
            <button type="button" className={linkButton} onClick={() => void copy("add")}>
              <Copy size={12} aria-hidden="true" />
              {copied === "add" ? "Copied" : "Copy Claude Code command"}
            </button>
          </div>
          <p className="text-[11px] text-cool-grey">
            Those sessions keep all their usual tools, so they can also change files on this Mac, including VibeCut&rsquo;s own. Your permission prompts are
            what guard them.
          </p>
          <pre className="mt-0.5 select-all whitespace-pre-wrap break-all rounded border border-border bg-canvas p-1.5 font-mono text-[10px] text-white">
            {setup.claudeAdd}
          </pre>
        </>
      ) : null}
    </Section>
  );
}
