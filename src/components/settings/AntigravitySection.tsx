import { useEffect, useState } from "react";
import { FolderSearch, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { addAntigravityTools, chooseFile, removeAntigravityTools, setAntigravity } from "../../lib/ipc";
import { useSystemStore } from "../../store/useSystemStore";
import { antigravityUsable, type AntigravityStatus } from "../../types/agent";
import { Section } from "../common/Section";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

const FAMILY_NAMES: Record<string, string> = { "gemini-4-argon": "Gemini 4 Argon", "gemini-3.8-flash": "Gemini 3.8 Flash" };

function toolsText(status: AntigravityStatus | null): string {
  if (!status) return "Unknown";
  if (status.toolsCurrent) return "Added";
  return status.toolsAdded ? "An older copy: update them" : "Not added";
}

/**
 * Settings > Gemini subscription (PLAN.md, Phase 17): the Gemini "(subscription)" models run the user's
 * own signed-in Antigravity CLI (`agy`), so they need no API key. Rust finds the agy program (or uses
 * the one chosen here). agy has no per-run MCP config, so VibeCut's tools are added to the user's own
 * agy config, and only when they press Add here.
 */
export function AntigravitySection() {
  const status = useSystemStore((s) => s.antigravity);
  const refreshAntigravity = useSystemStore((s) => s.refreshAntigravity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (useSystemStore.getState().antigravity === null) void refreshAntigravity();
  }, [refreshAntigravity]);

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

  const apply = (work: () => Promise<AntigravityStatus>) => run(async () => useSystemStore.getState().setAntigravity(await work()));

  const chooseProgram = async () => {
    const path = await chooseFile("Choose the agy program", [], status?.program ?? undefined).catch(() => null);
    if (path) await apply(() => setAntigravity(path));
  };

  const usable = antigravityUsable(status);
  const headline = status === null ? "Checking Antigravity…" : usable ? "Signed in" : status.signedIn ? "Signed in, not ready yet" : "Not ready";
  const models = status?.models.map((m) => FAMILY_NAMES[m] ?? m).join(", ");

  return (
    <Section
      title="Gemini subscription"
      action={
        <button type="button" className={linkButton} disabled={busy} onClick={() => void run(refreshAntigravity)}>
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
            <button type="button" className={linkButton} disabled={busy} onClick={() => void apply(() => setAntigravity(null))}>
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

      {models ? (
        <div className="mt-2">
          <p className="text-[11px] text-cool-grey">Gemini models on your plan</p>
          <p className="text-[11px] text-white">{models}</p>
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-cool-grey">VibeCut&rsquo;s tools in Antigravity</p>
          <p className="text-[11px] text-white">{toolsText(status)}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {status?.toolsAdded ? (
            <button type="button" className={linkButton} disabled={busy || !status.program} onClick={() => void apply(removeAntigravityTools)}>
              <Trash2 size={12} aria-hidden="true" />
              Remove
            </button>
          ) : null}
          {!status?.toolsCurrent ? (
            <button type="button" className={linkButton} disabled={busy || !status?.program} onClick={() => void apply(addAntigravityTools)}>
              <Plus size={12} aria-hidden="true" />
              {status?.toolsAdded ? "Update" : "Add"}
            </button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-cool-grey">
        The Gemini &ldquo;(subscription)&rdquo; models run your own Antigravity CLI on an agent of VibeCut&rsquo;s with only its editing tools: no shell, files,
        browser or web. Add puts a <span className="font-mono">vibecut</span> server in your agy config (<span className="font-mono">~/.gemini/config/mcp_config.json</span>
        ); your own agy sessions can see it, but VibeCut refuses their calls unless Outside control allows them. Text only (no images, so the edit review critic
        needs Gemini Flash with a key). Turns count against your Google AI plan&rsquo;s limits. For your own use on this Mac only.
      </p>
    </Section>
  );
}
