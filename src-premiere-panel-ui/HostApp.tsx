import { useState } from "react";
import { HOST_PANEL_VERSION } from "../src/types/hostPanel";
import { AnalyzeTab } from "./AnalyzeTab";
import { Broll } from "./Broll";
import { ChatTab } from "./ChatTab";
import { HistoryTab } from "./HistoryTab";
import { Press } from "./Press";
import { EditorLights, StatusBar, UsageMeter } from "./StatusParts";
import type { Transport } from "./transport";
import { useHostPanel } from "./useHostPanel";

/**
 * The "VibeCut Agent" panel inside Premiere Pro (Window → Extensions → VibeCut Agent) and DaVinci Resolve
 * (Workspace → Workflow Integrations → VibeCut Agent), `vibecut.host.panels.v1`: Chat · Library · Analyze ·
 * History tabs over the menu-bar app's own conversation, Library and B-Roll Analyzer, and a Window button
 * that brings up the app's floating window. Since 0.20.0 the window's header and footer too: each editor's
 * light, the usage tracker, and the agent's state and model. One component for both editors; only the
 * transport differs (cepChat.tsx, electron.tsx).
 */

type Tab = "chat" | "broll" | "analyze" | "history";

const TABS: { id: Tab; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "The editing agent" },
  { id: "broll", label: "Library", title: "Search and browse Spyglass's index of your archive (the B-roll Library)" },
  { id: "analyze", label: "Analyze", title: "Rank the clips in a folder and export or build the best segments (B-Roll Analyzer)" },
  { id: "history", label: "History", title: "Your saved chats" },
];

export function HostApp({ transport, hostName }: { transport: Transport; hostName: string }) {
  const view = useHostPanel(transport);
  const { state, broll, analyzer, agentRunning, otherVersion } = view;
  const [tab, setTab] = useState<Tab>("chat");
  const live = !!state && agentRunning;
  const connected = !!state?.editor.connected;
  const dot = agentRunning && connected ? "vc-dot vc-dot-on" : agentRunning ? "vc-dot vc-dot-wait" : "vc-dot vc-dot-off";
  const status = !agentRunning
    ? "VibeCut Agent isn't running — launch it from the top menu bar"
    : otherVersion !== null && !state
      ? "This panel and VibeCut Agent don't match"
      : !state
      ? "Connecting to VibeCut Agent…"
      : connected
        ? [state.editor.project, state.editor.timeline].filter(Boolean).join(" · ") || `Connected to ${hostName}`
        : (state.editor.noEditor ?? `VibeCut Agent isn't connected to ${hostName}`);
  const notice = tab === "broll" ? broll?.notice : tab === "analyze" ? null : state?.notice;
  return (
    <div className="vc-panel">
      <div className="vc-header vc-slim">
        {live ? <EditorLights state={state} /> : <span className={dot} />}
        {live ? <UsageMeter state={state} view={view} /> : null}
        <span className="vc-grow vc-truncate vc-muted" title={status}>
          {status}
        </span>
        <Press
          className="vc-btn"
          disabled={!agentRunning}
          title="Open VibeCut Agent's floating window"
          onClick={() => view.act({ type: "open_window", view: tab === "broll" ? "library" : tab === "analyze" ? "broll" : "chat" })}
        >
          Window
        </Press>
      </div>
      {view.writeError && <p className="vc-error">Couldn't reach VibeCut Agent: {view.writeError}</p>}
      {agentRunning && otherVersion !== null && !state && (
        <p role="alert" className="vc-notice vc-error">
          {otherVersion > HOST_PANEL_VERSION
            ? "VibeCut Agent is newer than this panel. In VibeCut Agent, open Settings → Editors and press Update, then restart this editor."
            : "This panel is newer than VibeCut Agent. Update VibeCut Agent, then reopen this panel."}
        </p>
      )}
      {live && notice && (
        <p role={notice.failed ? "alert" : "status"} className={notice.failed ? "vc-notice vc-error" : "vc-notice vc-muted"}>
          {notice.text}
        </p>
      )}
      {live && (
        <div className="vc-tabs" role="tablist" aria-label="VibeCut Agent">
          {TABS.map((t) => (
            <Press key={t.id} role="tab" aria-selected={tab === t.id} title={t.title} className={tab === t.id ? "vc-tab vc-tab-on" : "vc-tab"} onClick={() => setTab(t.id)}>
              {t.label}
            </Press>
          ))}
        </div>
      )}
      {live && tab === "chat" && <ChatTab state={state} view={view} copy={transport.copyText} />}
      {live && tab === "broll" && (broll ? <Broll file={broll} view={view} transport={transport} /> : <p className="vc-muted vc-empty vc-pad">Loading the B-roll…</p>)}
      {live && tab === "analyze" && <AnalyzeTab file={analyzer} view={view} transport={transport} />}
      {live && tab === "history" && <HistoryTab state={state} view={view} onOpen={() => setTab("chat")} />}
      {live && <StatusBar state={state} />}
    </div>
  );
}
