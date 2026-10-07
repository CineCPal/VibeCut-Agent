import { useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { restartSession } from "../../lib/ipc";
import { useAgentStore } from "../../store/useAgentStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useUiStore } from "../../store/useUiStore";
import { toggleKeepOnTop } from "../../hooks/useKeepOnTop";
import { useSystemStore } from "../../store/useSystemStore";
import { AI_CHOICES, claudeCodeUsable, type AiProvider, type ChoiceAccess, type ClaudeCodeStatus } from "../../types/agent";
import { NLE_HOSTS, NLE_LABELS, type PreferredHost } from "../../types/nle";
import type { KeyStatus } from "../../types/system";
import { DependencyList } from "../common/DependencyList";
import { ApiKeysSection } from "./ApiKeysSection";
import { EditorsSection } from "./EditorsSection";
import { LibrarySection } from "./LibrarySection";
import { ClaudeCodeSection } from "./ClaudeCodeSection";
import { OutsideControlSection } from "./OutsideControlSection";
import { Modal } from "../common/Modal";
import { SidecarStatusRow } from "../common/SidecarStatusRow";
import { Section } from "../common/Section";

export const KEY_ENV: Record<AiProvider, { label: string; env: string }> = {
  gemini: { label: "Gemini", env: "GEMINI_API_KEY" },
  anthropic: { label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY" },
};

export function providerReady(keys: KeyStatus | null, provider: ChoiceAccess, claudeCode: ClaudeCodeStatus | null = null): boolean {
  if (provider === "claude-code") return claudeCodeUsable(claudeCode);
  return keys?.[provider] ?? false;
}

const fieldClass = "w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-sm text-white";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const aiChoice = useAgentStore((s) => s.aiChoice);
  const setAiChoice = useAgentStore((s) => s.setAiChoice);
  const storyFirstPass = useAgentStore((s) => s.storyFirstPass);
  const setStoryFirstPass = useAgentStore((s) => s.setStoryFirstPass);
  const preferredHost = useNleStateStore((s) => s.preferredHost);
  const setPreferredHost = useNleStateStore((s) => s.setPreferredHost);
  const keys = useSystemStore((s) => s.keys);
  const claudeCode = useSystemStore((s) => s.claudeCode);
  const loading = useSystemStore((s) => s.loading);
  const error = useSystemStore((s) => s.error);
  const refresh = useSystemStore((s) => s.refresh);
  const sidecar = useSystemStore((s) => s.sidecar);
  const [restartError, setRestartError] = useState<string | null>(null);
  const keepOnTop = useUiStore((s) => s.keepOnTop);
  const autoTitles = useAgentStore((s) => s.autoTitles);
  const setAutoTitles = useAgentStore((s) => s.setAutoTitles);

  const restart = () => {
    setRestartError(null);
    restartSession().catch((error: unknown) => setRestartError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <Section title="Agent model">
        <label htmlFor="settings-model" className="sr-only">
          Agent model
        </label>
        <select
          id="settings-model"
          className={fieldClass}
          value={aiChoice}
          onChange={(event) => setAiChoice(event.target.value as typeof aiChoice)}
        >
          {AI_CHOICES.map((choice) => {
            const ready = providerReady(keys, choice.provider, claudeCode);
            const missing = choice.provider === "claude-code" ? " — Claude Code not ready" : " — key missing";
            return (
              <option key={choice.id} value={choice.id} disabled={!ready && choice.id !== aiChoice}>
                {choice.label}
                {ready ? "" : missing}
              </option>
            );
          })}
        </select>
        <label htmlFor="settings-first-pass" className="mt-2 block text-[11px] text-cool-grey">
          Story Editor on long footage (over 2,000 transcript lines): first read
        </label>
        <select
          id="settings-first-pass"
          className={`${fieldClass} mt-0.5`}
          value={storyFirstPass}
          onChange={(event) => setStoryFirstPass(event.target.value === "gemini" ? "gemini" : "same")}
        >
          <option value="same">Same provider as the agent (Claude Sonnet, or Gemini Flash)</option>
          <option value="gemini" disabled={!keys?.gemini && storyFirstPass !== "gemini"}>
            Gemini Flash{keys?.gemini ? "" : " — key missing"}
          </option>
        </select>
        <p className="mt-1 text-[11px] text-cool-grey">
          It reads every line and shortlists the strongest moments, then the agent&rsquo;s model cuts the story from them. Text only. Gemini Flash is faster and
          spares your Claude plan&rsquo;s limits, but sends the transcripts to Google.
        </p>
      </Section>

      <Section title="Chat">
        <label className="flex items-start gap-2 text-xs text-white">
          <input
            type="checkbox"
            className="mt-0.5 accent-athletic-blue-light"
            checked={autoTitles}
            onChange={(e) => setAutoTitles(e.target.checked)}
          />
          <span>
            Name chats with the model
            <span className="block text-[11px] text-cool-grey">
              After a chat&rsquo;s first answer, the agent&rsquo;s model gives it a short name for History. It&rsquo;s one small extra call per new chat, on your
              Claude plan too. Off: chats are named after their first message. A name you give a chat always stays.
            </span>
          </span>
        </label>
      </Section>

      <Section title="Window">
        <label className="flex items-start gap-2 text-xs text-white">
          <input
            type="checkbox"
            className="mt-0.5 accent-athletic-blue-light"
            checked={keepOnTop ?? true}
            disabled={keepOnTop === null}
            onChange={(e) => void toggleKeepOnTop(e.target.checked)}
          />
          <span>
            Keep on top of editors
            <span className="block text-[11px] text-cool-grey">
              Stays in front of other apps and shows over a full-screen Premiere Pro or DaVinci Resolve (it follows you to every Space). Also in the menu-bar menu and the pin in the header.
            </span>
          </span>
        </label>
      </Section>

      <ApiKeysSection />

      <ClaudeCodeSection />

      <EditorsSection />

      <LibrarySection />

      <OutsideControlSection />

      <Section title="Preferred editor">
        <label htmlFor="settings-host" className="sr-only">
          Preferred editor
        </label>
        <select
          id="settings-host"
          className={fieldClass}
          value={preferredHost}
          onChange={(event) => setPreferredHost(event.target.value as PreferredHost)}
        >
          <option value="auto">Automatic (first connected)</option>
          {NLE_HOSTS.map((host) => (
            <option key={host} value={host}>
              {NLE_LABELS[host]}
            </option>
          ))}
        </select>
      </Section>

      <Section
        title="Agent sidecar"
        action={
          <button
            type="button"
            onClick={restart}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white"
          >
            <RotateCcw size={12} aria-hidden="true" />
            Restart
          </button>
        }
      >
        <ul className="divide-y divide-border">
          <SidecarStatusRow />
        </ul>
        {sidecar ? (
          <p className="mt-1 break-all font-mono text-[11px] text-cool-grey">
            {sidecar.installed ? sidecar.pythonRoot : `Not installed at ${sidecar.pythonRoot}`}
          </p>
        ) : null}
        {restartError ? (
          <p role="alert" className="mt-1 text-xs text-loss">
            {restartError}
          </p>
        ) : null}
      </Section>

      <Section
        title="Local dependencies"
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
        {error ? <p role="alert" className="mb-1 text-xs text-loss">{error}</p> : null}
        <DependencyList />
      </Section>
    </Modal>
  );
}
