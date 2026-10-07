import { Info, Minimize2, Pin, PinOff, Settings } from "lucide-react";
import { toggleKeepOnTop } from "../../hooks/useKeepOnTop";
import { toggleMiniPlayer } from "../../hooks/useMiniPlayer";
import { UsageMeter } from "../usage/UsageMeter";
import { useUiStore } from "../../store/useUiStore";
import { ChatPanel } from "../chat/ChatPanel";
import { BrollPanel } from "../broll/BrollPanel";
import { NleStatusPill } from "./NleStatusPill";
import { TabBar, panelId, tabId } from "./TabBar";

const iconButton = "rounded p-1.5 text-cool-grey hover:bg-surface hover:text-athletic-blue-light";

export function AppShell() {
  const tab = useUiStore((s) => s.tab);
  const openOverlay = useUiStore((s) => s.openOverlay);
  const keepOnTop = useUiStore((s) => s.keepOnTop);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold tracking-tight text-white">VibeCut Agent</h1>
        <div className="flex items-center gap-1">
          <NleStatusPill />
          <UsageMeter />
          {keepOnTop !== null ? (
            <button
              type="button"
              className={`${iconButton} ${keepOnTop ? "text-athletic-blue-light" : ""}`}
              onClick={() => void toggleKeepOnTop(!keepOnTop)}
              aria-label="Keep on top of editors"
              aria-pressed={keepOnTop}
              title={keepOnTop ? "On top of other apps, even a full-screen Premiere or Resolve (click to let it go behind)" : "Keep this window on top of other apps, even a full-screen editor"}
            >
              {keepOnTop ? <Pin size={16} aria-hidden="true" /> : <PinOff size={16} aria-hidden="true" />}
            </button>
          ) : null}
          <button type="button" className={iconButton} onClick={() => void toggleMiniPlayer(true)} aria-label="Mini Player" title="Mini Player (⌥⌘M)">
            <Minimize2 size={16} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} onClick={() => openOverlay("settings")} aria-label="Settings" title="Settings (⌘,)">
            <Settings size={16} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} onClick={() => openOverlay("about")} aria-label="About This App" title="About This App (⌘I)">
            <Info size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <TabBar />
      <main id={panelId(tab)} role="tabpanel" aria-labelledby={tabId(tab)} className="flex min-h-0 flex-1 flex-col">
        {tab === "chat" ? <ChatPanel /> : <BrollPanel />}
      </main>
    </div>
  );
}
