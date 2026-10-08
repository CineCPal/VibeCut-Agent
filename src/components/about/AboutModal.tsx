import { useEffect, useState } from "react";
import { getAppVersion } from "../../lib/ipc";
import { refreshIndex } from "../../lib/library";
import { useAgentStore } from "../../store/useAgentStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { INDEX_SOURCE } from "../settings/LibrarySection";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useSystemStore } from "../../store/useSystemStore";
import { AI_CHOICES, claudeCodeUsable } from "../../types/agent";
import { NLE_HOSTS, NLE_LABELS } from "../../types/nle";
import { DependencyList } from "../common/DependencyList";
import { Modal } from "../common/Modal";
import { SidecarStatusRow } from "../common/SidecarStatusRow";
import { Section } from "../common/Section";
import { StatusRow } from "../common/StatusRow";
import { CONNECTION_TEXT, CONNECTION_TONE, connectionDetail } from "../../lib/nleStatus";
import { KEY_ENV } from "../settings/SettingsPanel";

export const APP_DESCRIPTION =
  "A menu-bar AI editing assistant that works alongside Premiere Pro and DaVinci Resolve: an agent chat for multi-step timeline edits, a B-roll Library over Spyglass's index of your archive, and a B-roll analyzer for folders on disk.";

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
            detail={!model ? undefined : model.provider === "claude-code" ? "Your Claude subscription, through Claude Code" : KEY_ENV[model.provider].env}
          />
          <StatusRow
            label="Claude Code (subscription)"
            tone={claudeCodeUsable(claudeCode) ? "ok" : "off"}
            value={claudeCode === null ? "Unknown" : claudeCodeUsable(claudeCode) ? `Signed in${claudeCode.subscription ? ` (${claudeCode.subscription})` : ""}` : "Not ready"}
            detail={`Your own Claude Code (${claudeCode?.program ?? "claude"}), which calls api.anthropic.com · only while chatting with a "(subscription)" model (with any images you attach), and for its Story Editor cuts (the interviews' transcripts are sent) · counts against your Claude plan's usage limits · the usage meter reads the plan's limits from Claude Code's own reports and its /usage (answered without a model call) · tool calls come back through VibeCut's MCP bridge (files, no network port)`}
          />
          <StatusRow
            label="Gemini API"
            tone={keys?.gemini ? "ok" : "off"}
            value={keys?.gemini ? "Key configured" : "Not configured"}
            detail={`generativelanguage.googleapis.com · only while chatting with Gemini (with any images you attach; its Story Editor cuts too: the interviews' transcripts are sent; and naming its chats, from the first message and answer), or for the Story Editor's first read of long footage when Settings sets it to Gemini Flash${keys?.geminiSource ? ` · key ${keys.geminiSource === "keychain" ? "in the Keychain" : "from the environment"}` : ""}`}
          />
          <StatusRow
            label="Anthropic API"
            tone={keys?.anthropic ? "ok" : "off"}
            value={keys?.anthropic ? "Key configured" : "Not configured"}
            detail={`api.anthropic.com · only while chatting with Claude (with any images you attach; its Story Editor cuts too: the interviews' transcripts are sent)${keys?.anthropicSource ? ` · key ${keys.anthropicSource === "keychain" ? "in the Keychain" : "from the environment"}` : ""}`}
          />
          <StatusRow
            label="Hugging Face"
            tone="off"
            value="First content-aware run only"
            detail={`huggingface.co · downloads the SigLIP 2 and Whisper models once (analysis, Library search and transcripts then run offline); with a token, pyannote's speaker models${keys?.huggingfaceSource ? ` · token ${keys.huggingfaceSource === "keychain" ? "in the Keychain" : "from the environment"}` : ""}`}
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

      <Section title="Binaries">
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
