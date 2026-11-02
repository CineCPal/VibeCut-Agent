import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getAppVersion } from "../../lib/ipc";
import { runJob } from "../../lib/jobs";
import { refreshIndex } from "../../lib/library";
import { useAgentStore } from "../../store/useAgentStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { INDEX_SOURCE } from "../settings/LibrarySection";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useSystemStore } from "../../store/useSystemStore";
import { AI_CHOICES, KEY_ENV, claudeCodeUsable } from "../../types/agent";
import { NLE_HOSTS, NLE_LABELS } from "../../types/nle";
import type { OrchestratorHealth } from "../../types/orchestrator";
import { DependencyList } from "../common/DependencyList";
import { Modal } from "../common/Modal";
import { SidecarStatusRow } from "../common/SidecarStatusRow";
import { Section } from "../common/Section";
import { StatusRow } from "../common/StatusRow";
import { CONNECTION_TEXT, CONNECTION_TONE, connectionDetail } from "../../lib/nleStatus";

export const APP_DESCRIPTION =
  "A menu-bar AI editing assistant that works alongside Premiere Pro and DaVinci Resolve: an agent chat for multi-step timeline edits, a B-roll Library over Spyglass's index of your archive, and a B-roll analyzer for folders on disk.";

/** The local workers' names (workers/health_report.py), as the About modal shows them. */
export const WORKER_LABELS: Record<string, string> = {
  whisper: "Speech (Whisper)",
  vlm: "Vision (local VLM)",
  vector: "Media index (sqlite-vec)",
  gemma: "Edit validator (Gemma)",
};

/** Phase 21: EXECUTION_MODE, and in orchestrated mode the health of each local sub-agent (the
 * `orchestrator-health` command, run when About opens). */
function LocalAgentsSection() {
  const [health, setHealth] = useState<OrchestratorHealth | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    runJob("orchestrator-health", "Check the local sub-agents", {})
      .then((job) => active && setHealth(job?.status === "done" && job.result ? (job.result as unknown as OrchestratorHealth) : null))
      .catch(() => active && setHealth(null));
    return () => {
      active = false;
    };
  }, []);

  const orchestrated = health?.executionMode === "orchestrated";
  return (
    <Section title="Local sub-agents">
      <ul className="divide-y divide-border">
        <StatusRow
          label="Execution mode"
          tone={health === undefined || health === null ? "off" : "ok"}
          value={health === undefined ? "Checking…" : health === null ? "Unknown" : orchestrated ? "Orchestrated" : "Direct"}
          detail={
            health === undefined || health === null
              ? "Set by EXECUTION_MODE (direct or orchestrated) when the app starts"
              : orchestrated
                ? `Claude (subscription) plans each change as an OTIO delta, checked on this Mac before it reaches the editor; a Gemini chat edits directly · local models at ${health.localLlmBaseUrl} (Ollama or llama.cpp, on this Mac) · index in ${health.indexDir}`
                : "The chat's model calls the editor's tools itself (EXECUTION_MODE=direct); no local sub-agents run"
          }
        />
        {orchestrated
          ? health.workers.map((w) => (
              <StatusRow
                key={w.worker}
                label={WORKER_LABELS[w.worker] ?? w.worker}
                tone={w.available ? "ok" : "warn"}
                value={w.available ? "Ready" : "Unavailable"}
                detail={[w.backend, w.model, w.detail].filter(Boolean).join(" · ")}
              />
            ))
          : null}
      </ul>
    </Section>
  );
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const keys = useSystemStore((s) => s.keys);
  const claudeCode = useSystemStore((s) => s.claudeCode);
  const hwAccel = useSystemStore((s) => s.hwAccel);
  const storage = useSystemStore((s) => s.storage);
  const sidecar = useSystemStore((s) => s.sidecar);
  const hosts = useNleStateStore((s) => s.hosts);
  const aiChoice = useAgentStore((s) => s.aiChoice);
  const spyglass = useLibraryStore((s) => s.index);
  const loading = useSystemStore((s) => s.loading);
  const error = useSystemStore((s) => s.error);
  const refresh = useSystemStore((s) => s.refresh);
  const model = AI_CHOICES.find((c) => c.id === aiChoice);

  useEffect(() => {
    if (useLibraryStore.getState().index === undefined) void refreshIndex();
    let active = true;
    getAppVersion()
      .then((v) => active && setVersion(v))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const subscription = model?.provider === "claude-code";
  const modelKeyReady = !model ? false : model.provider === "claude-code" ? claudeCodeUsable(claudeCode) : keys ? keys[model.provider] : false;
  const modelChecked = subscription ? claudeCode !== null : keys !== null;
  const readyText = subscription ? "Claude Code signed in" : "Key configured";
  const missingText = subscription ? "Claude Code not ready" : "Key missing";
  const modelDetail = !model ? undefined : model.provider === "claude-code" ? "Your Claude subscription, through Claude Code" : KEY_ENV[model.provider];

  return (
    <Modal title="About This App" onClose={onClose}>
      <Section title="VibeCut Agent">
        <p className="font-mono text-xs text-white">Version {version ?? "—"}</p>
        <p className="mt-1 text-xs">{APP_DESCRIPTION}</p>
      </Section>

      <Section title="Network & API">
        <ul className="divide-y divide-border">
          <StatusRow
            label={`Active model: ${model?.label ?? aiChoice}`}
            tone={!modelChecked ? "off" : modelKeyReady ? "ok" : "warn"}
            value={!modelChecked ? "Unknown" : modelKeyReady ? readyText : missingText}
            detail={modelDetail}
          />
          <StatusRow
            label="Claude Code (subscription)"
            tone={claudeCodeUsable(claudeCode) ? "ok" : "off"}
            value={claudeCode === null ? "Unknown" : claudeCodeUsable(claudeCode) ? `Signed in${claudeCode.subscription ? ` (${claudeCode.subscription})` : ""}` : "Not ready"}
            detail={`Your own Claude Code (${claudeCode?.program ?? "claude"}), which calls api.anthropic.com · only while chatting with a "(subscription)" model (with any images you attach), and for its Story Editor cuts (the interviews' transcripts are sent), for naming its chats when the local model can't, and, when Settings sets the critic to the agent's model, review_edit's critic (stills from the cut and what is said) · counts against your Claude plan's usage limits · the usage meter reads the plan's limits from Claude Code's own reports and its /usage (answered without a model call) · tool calls come back through VibeCut's MCP bridge (files, no network port)`}
          />
          <StatusRow
            label="Gemini API"
            tone={keys?.gemini ? "ok" : "off"}
            value={keys?.gemini ? "Key configured" : "Not configured"}
            detail={`generativelanguage.googleapis.com · Gemini 3.8 Flash and Gemini 3.1 Pro · only while chatting with Gemini (with any images you attach; its Story Editor cuts too: the interviews' transcripts are sent; and naming its chats when the local model can't, from the first message and answer), for review_edit's critic by default, whatever the chat model (stills from the cut and what is said; when Settings sets the critic to Local, only if the local model can't review), or for the Story Editor's first read of long footage when Settings sets it to Gemini Flash${keys?.geminiSource ? ` · key ${keys.geminiSource === "keychain" ? "in the Keychain" : "from the environment"}` : ""}`}
          />
          <StatusRow
            label="Hugging Face"
            tone="off"
            value="First content-aware run only"
            detail={`huggingface.co · downloads the SigLIP 2 and Whisper models once (analysis, Library search and transcripts then run offline); with a token, pyannote's speaker models${keys?.huggingfaceSource ? ` · token ${keys.huggingfaceSource === "keychain" ? "in the Keychain" : "from the environment"}` : ""}`}
          />
          <StatusRow
            label="Local models"
            tone="ok"
            value="On this Mac"
            detail="The local model server (Ollama or llama.cpp, VIBECUT_LOCAL_LLM_BASE_URL, 127.0.0.1:11434 by default) · names each chat with Gemma when it is there and the GPU is free, so no cloud model is asked · reviews edits with Qwen3-VL when Settings sets the critic to Local · in orchestrated mode, the sub-agents too · nothing it reads leaves this Mac"
          />
          <StatusRow
            label="Spyglass index"
            tone={spyglass ? "ok" : "off"}
            value={spyglass ? "Read only, local" : spyglass === null ? "No index found" : "Not checked yet"}
            detail={spyglass ? `${spyglass.path} · ${INDEX_SOURCE[spyglass.source]}` : "Rough Cut Studio Suite's Spyglass; choose it in Settings → B-roll Library"}
          />
          <StatusRow
            label="B-roll analyzer"
            tone="ok"
            value="Local only"
            detail="Scoring, segment previews and XML exports read the footage on this Mac and upload nothing; a preview can read only the clip you play"
          />
          <StatusRow
            label="Notifications"
            tone="ok"
            value="Local only"
            detail="Shown by macOS when an answer finishes or a change waits for review while the window is away; nothing is sent anywhere"
          />
          <SidecarStatusRow />
          {NLE_HOSTS.map((host) => (
            <StatusRow
              key={host}
              label={NLE_LABELS[host]}
              tone={CONNECTION_TONE[hosts[host].status]}
              value={CONNECTION_TEXT[hosts[host].status]}
              detail={connectionDetail(hosts[host]) ?? undefined}
            />
          ))}
        </ul>
      </Section>

      <LocalAgentsSection />

      <Section
        title="Binaries"
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={12} aria-hidden="true" className={loading ? "animate-spin" : undefined} />
            Refresh
          </button>
        }
      >
        {error ? (
          <p role="alert" className="mb-1 text-xs text-loss">
            {error}
          </p>
        ) : null}
        <DependencyList />
      </Section>

      <Section title="Hardware acceleration">
        <ul className="divide-y divide-border">
          <StatusRow
            label="VideoToolbox (Apple)"
            tone={hwAccel?.videotoolbox ? "ok" : "off"}
            value={hwAccel === null ? "Unknown" : hwAccel.videotoolbox ? "Available" : "Unavailable"}
          />
          <StatusRow
            label="NVENC (NVIDIA)"
            tone={hwAccel?.nvenc ? "ok" : "off"}
            value={hwAccel === null ? "Unknown" : hwAccel.nvenc ? "Built into ffmpeg" : "Unavailable"}
          />
        </ul>
      </Section>

      <Section title="Storage">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {(
            [
              ["Config", storage?.config],
              ["Data", storage?.data],
              ["Logs", storage?.logs],
              ["Chats & edit log", storage?.history],
              ["Sidecar", sidecar?.pythonRoot],
              ["Python env", sidecar ? (sidecar.environment ?? `${sidecar.pythonRoot}/.venv`) : null],
            ] as const
          ).map(([label, path]) => (
            <div key={label} className="contents">
              <dt className="text-cool-grey">{label}</dt>
              <dd className="select-text break-all font-mono text-[11px] text-white">{path ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </Modal>
  );
}
