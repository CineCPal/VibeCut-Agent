import { useEffect, useState } from "react";
import { FolderSearch, RefreshCw, RotateCcw } from "lucide-react";
import { chooseFile, chooseFolder, setClaudeCode } from "../../lib/ipc";
import { useSystemStore } from "../../store/useSystemStore";
import { claudeCodeUsable } from "../../types/agent";
import { Section } from "../common/Section";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

/**
 * Settings > Claude subscription (PLAN.md, Phase 7b): the "(subscription)" models run the user's own
 * signed-in Claude Code, so they need no API key. Rust finds the claude program (or uses the one chosen
 * here) and runs it with the Claude Code profile folder chosen here (`CLAUDE_CONFIG_DIR`); the app's
 * sidecar never runs the user's shell, so a profile picked by a shell function must be chosen here.
 */
export function ClaudeCodeSection() {
  const status = useSystemStore((s) => s.claudeCode);
  const refreshClaudeCode = useSystemStore((s) => s.refreshClaudeCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (useSystemStore.getState().claudeCode === null) void refreshClaudeCode();
  }, [refreshClaudeCode]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (program: string | null, configDir: string | null) =>
    run(async () => useSystemStore.getState().setClaudeCode(await setClaudeCode(program, configDir)));

  const chooseProgram = async () => {
    const path = await chooseFile("Choose the claude program", [], status?.program ?? undefined).catch(() => null);
    if (path) await save(path, status?.configDir ?? null);
  };

  const chooseProfile = async () => {
    const path = await chooseFolder("Choose the Claude Code profile folder (CLAUDE_CONFIG_DIR)", status?.configDir ?? undefined).catch(() => null);
    if (path) await save(status?.programSaved ?? null, path);
  };

  const usable = claudeCodeUsable(status);
  const headline =
    status === null
      ? "Checking Claude Code…"
      : usable
        ? `Signed in${status.email ? ` as ${status.email}` : ""}${status.subscription ? ` · ${status.subscription}` : ""}`
        : "Not ready";

  return (
    <Section
      title="Claude subscription"
      action={
        <button type="button" className={linkButton} disabled={busy} onClick={() => void run(refreshClaudeCode)}>
          <RefreshCw size={12} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
          Check
        </button>
      }
    >
      <p className={`text-xs ${usable ? "text-white" : "text-warning"}`}>{headline}</p>
      {status?.detail ? <p className="mt-0.5 text-[11px] text-warning">{status.detail}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-cool-grey">Program</p>
          <p className="break-all font-mono text-[11px] text-white">{status?.program ?? "Not found"}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {status?.programSaved ? (
            <button type="button" className={linkButton} disabled={busy} onClick={() => void save(null, status.configDir)}>
              <RotateCcw size={12} aria-hidden="true" />
              Find it
            </button>
          ) : null}
          <button type="button" className={linkButton} disabled={busy} onClick={() => void chooseProgram()}>
            <FolderSearch size={12} aria-hidden="true" />
            Choose…
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-cool-grey">Profile folder (CLAUDE_CONFIG_DIR)</p>
          <p className="break-all font-mono text-[11px] text-white">{status?.configDir ?? "Claude Code's default (~/.claude)"}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {status?.configDir ? (
            <button type="button" className={linkButton} disabled={busy} onClick={() => void save(status.programSaved, null)}>
              <RotateCcw size={12} aria-hidden="true" />
              Default
            </button>
          ) : null}
          <button type="button" className={linkButton} disabled={busy} onClick={() => void chooseProfile()}>
            <FolderSearch size={12} aria-hidden="true" />
            Choose…
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-cool-grey">
        The &ldquo;(subscription)&rdquo; models run your own Claude Code with only VibeCut&rsquo;s editing tools: no shell, files or web. Turns count against your Claude
        plan&rsquo;s usage limits. For your own use on this Mac only. The Story Editor uses it too, with no key.
      </p>
    </Section>
  );
}
