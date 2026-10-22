import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useUiStore, type SettingsTab } from "../../store/useUiStore";
import { Modal } from "../common/Modal";
import { AgentModelSection } from "./AgentModelSection";
import { AntigravitySection } from "./AntigravitySection";
import { ApiKeysSection } from "./ApiKeysSection";
import { ChatSection } from "./ChatSection";
import { ClaudeCodeSection } from "./ClaudeCodeSection";
import { EditorsSection } from "./EditorsSection";
import { LibrarySection } from "./LibrarySection";
import { NotificationsSection } from "./NotificationsSection";
import { OutsideControlSection } from "./OutsideControlSection";
import { PreferredEditorSection } from "./PreferredEditorSection";
import { PromptsSection } from "./PromptsSection";
import { WindowSection } from "./WindowSection";

/** Settings' tabs (Phase 11a). What only reports a state (the sidecar, local programs, connection details) lives in About. */
export const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "general", label: "General", hint: "The window and notifications" },
  { id: "agent", label: "Agent", hint: "The chat's model, effort and saved prompts" },
  { id: "accounts", label: "Accounts", hint: "API keys and your Claude subscription" },
  { id: "editors", label: "Editors", hint: "Premiere Pro and DaVinci Resolve, and outside control" },
  { id: "library", label: "Library", hint: "The Spyglass index the B-roll Library reads" },
];

const settingsTabId = (tab: SettingsTab) => `settings-tab-${tab}`;
const settingsPanelId = (tab: SettingsTab) => `settings-panel-${tab}`;

function tabContent(tab: SettingsTab): ReactNode {
  switch (tab) {
    case "general":
      return (
        <>
          <WindowSection />
          <NotificationsSection />
        </>
      );
    case "agent":
      return (
        <>
          <AgentModelSection />
          <ChatSection />
          <PromptsSection />
        </>
      );
    case "accounts":
      return (
        <>
          <ApiKeysSection />
          <ClaudeCodeSection />
          <AntigravitySection />
        </>
      );
    case "editors":
      return (
        <>
          <PreferredEditorSection />
          <EditorsSection />
          <OutsideControlSection />
        </>
      );
    case "library":
      return <LibrarySection />;
  }
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const tab = useUiStore((s) => s.settingsTab);
  const setTab = useUiStore((s) => s.setSettingsTab);
  const refs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SETTINGS_TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % SETTINGS_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SETTINGS_TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = SETTINGS_TABS[next].id;
    setTab(target);
    refs.current[target]?.focus();
  };

  const toolbar = (
    <div role="tablist" aria-label="Settings" className="flex gap-0.5 overflow-x-auto border-b border-border px-2" onKeyDown={onKeyDown}>
      {SETTINGS_TABS.map(({ id, label, hint }) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            id={settingsTabId(id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={settingsPanelId(id)}
            tabIndex={selected ? 0 : -1}
            title={hint}
            onClick={() => setTab(id)}
            className={`-mb-px shrink-0 border-b-2 px-2.5 py-2 text-xs font-medium transition-colors ${
              selected ? "border-athletic-blue-light text-white" : "border-transparent text-cool-grey hover:text-warm-grey"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <Modal title="Settings" onClose={onClose} toolbar={toolbar} fill>
      <div role="tabpanel" id={settingsPanelId(tab)} aria-labelledby={settingsTabId(tab)}>
        {tabContent(tab)}
      </div>
    </Modal>
  );
}
