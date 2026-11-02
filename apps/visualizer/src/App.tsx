/**
 * The 4-pane studio (visualizer-spec.md §4.1): the top bar; Pane A (the studio and DAG workspace) over
 * Pane B (the OTIO dock); Pane C (the inspector) on the right; Pane D (the terminal and replay log)
 * along the bottom. A narrow Premiere panel (embedded_cep) gets one column, with the inspector in a tab.
 *
 * Keys: 1/2/3 switch views, F fits the DAG, , and . step the replay, Esc deselects, ? opens About.
 */
import { useEffect, useState } from "react";
import { AboutVisualizerModal } from "./components/header/AboutVisualizerModal";
import { TopTelemetryBar } from "./components/header/TopTelemetryBar";
import { AgentInspectorDrawer } from "./components/inspector/AgentInspectorDrawer";
import { TerminalReplayDock } from "./components/terminal/TerminalReplayDock";
import { OtioTimelineDock } from "./components/timeline/OtioTimelineDock";
import { WorkspaceViewport } from "./components/workspace/WorkspaceViewport";
import type { RuntimeHostAdapter } from "./lib/host/runtimeHostAdapter";
import { useVisualizerStore } from "./store/useVisualizerStore";

export interface AppProps {
  adapter: RuntimeHostAdapter;
}

function useHotkeys() {
  const setViewMode = useVisualizerStore((s) => s.setViewMode);
  const selectTask = useVisualizerStore((s) => s.selectTask);
  const setAboutOpen = useVisualizerStore((s) => s.setAboutOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") setViewMode("split");
      else if (e.key === "2") setViewMode("studio");
      else if (e.key === "3") setViewMode("dag");
      else if (e.key === "?") setAboutOpen(true);
      else if (e.key === "Escape" && !useVisualizerStore.getState().aboutOpen) selectTask(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setViewMode, selectTask, setAboutOpen]);
}

function CompactLayout() {
  const [tab, setTab] = useState<"studio" | "inspector" | "timeline" | "log">("studio");
  const tabs = [
    ["studio", "Studio"],
    ["inspector", "Inspector"],
    ["timeline", "OTIO"],
    ["log", "Log"],
  ] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex border-b border-border bg-surface text-xs">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} className={`flex-1 px-2 py-1 ${tab === id ? "text-[#e6edf3]" : "text-cool-grey"}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "studio" && <WorkspaceViewport />}
        {tab === "inspector" && <AgentInspectorDrawer />}
        {tab === "timeline" && <OtioTimelineDock />}
        {tab === "log" && <TerminalReplayDock />}
      </div>
    </div>
  );
}

export default function App({ adapter }: AppProps) {
  useHotkeys();
  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-[#e6edf3]">
      <TopTelemetryBar />
      {adapter.compact ? (
        <CompactLayout />
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] grid-rows-[minmax(0,1fr)_minmax(0,14rem)]">
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,13rem)] border-r border-border">
            <div className="min-h-0 border-b border-border">
              <WorkspaceViewport />
            </div>
            <OtioTimelineDock />
          </div>
          <div className="row-span-1 min-h-0">
            <AgentInspectorDrawer />
          </div>
          <div className="col-span-2 min-h-0 border-t border-border">
            <TerminalReplayDock />
          </div>
        </main>
      )}
      <AboutVisualizerModal adapter={adapter} />
    </div>
  );
}
