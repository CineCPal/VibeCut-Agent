/**
 * The 4-pane studio (visualizer-spec.md §4.1): the top bar; Pane A (the studio and DAG workspace) over
 * Pane B (the OTIO dock); Pane C (the inspector) on the right; Pane D (the terminal and replay log)
 * along the bottom. A narrow Premiere panel (embedded_cep) gets one column, with the inspector in a tab;
 * choosing a task on another tab (a DAG node, a studio bay, a log row) also opens the inspector as a sheet
 * in the tab's lower part, closed with ✕ or Esc. The tab keeps the part above, so the DAG lays itself out
 * there rather than under the sheet.
 *
 * Keys: 1/2/3 switch views, F fits the DAG, T and L collapse or open the OTIO preview and the log (each to
 * its header, the space going to the panes above), , and . step the replay, Esc deselects, ? opens About.
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
  const toggleDock = useVisualizerStore((s) => s.toggleDock);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") setViewMode("split");
      else if (e.key === "2") setViewMode("studio");
      else if (e.key === "3") setViewMode("dag");
      else if (e.key === "?") setAboutOpen(true);
      else if (e.key === "t" || e.key === "T") toggleDock("otio");
      else if (e.key === "l" || e.key === "L") toggleDock("log");
      else if (e.key === "Escape" && !useVisualizerStore.getState().aboutOpen) selectTask(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setViewMode, selectTask, setAboutOpen, toggleDock]);
}

function CompactLayout() {
  const [tab, setTab] = useState<"studio" | "inspector" | "timeline" | "log">("studio");
  const selected = useVisualizerStore((s) => s.selectedTaskId);
  // The sheet opens for each task chosen; ✕ hides it and keeps the selection (the DAG stays lit).
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  useEffect(() => setSheetFor(selected), [selected]);
  const sheet = sheetFor !== null && sheetFor === selected && tab !== "inspector";
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
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {tab === "studio" && <WorkspaceViewport />}
          {tab === "inspector" && <AgentInspectorDrawer />}
          {tab === "timeline" && <OtioTimelineDock collapsible={false} />}
          {tab === "log" && <TerminalReplayDock collapsible={false} />}
        </div>
        {sheet && (
          <div role="dialog" aria-label="Task inspector" className="flex h-[58%] min-h-0 shrink-0 flex-col border-t border-athletic-blue-light bg-surface shadow-[0_-8px_24px_rgba(0,0,0,0.5)]">
            <div className="flex items-center border-b border-border px-3 py-1 text-xs">
              <span className="font-semibold text-[#e6edf3]">Inspector</span>
              <button type="button" className="ml-auto rounded px-1.5 text-cool-grey hover:text-white" onClick={() => setTab("inspector")}>
                Open as tab
              </button>
              <button type="button" aria-label="Close the inspector" className="rounded px-1.5 text-cool-grey hover:text-white" onClick={() => setSheetFor(null)}>
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <AgentInspectorDrawer />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App({ adapter }: AppProps) {
  useHotkeys();
  const collapsed = useVisualizerStore((s) => s.collapsedDocks);
  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-[#e6edf3]">
      <TopTelemetryBar />
      {adapter.compact ? (
        <CompactLayout />
      ) : (
        <main className={`grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] ${collapsed.log ? "grid-rows-[minmax(0,1fr)_auto]" : "grid-rows-[minmax(0,1fr)_minmax(0,14rem)]"}`}>
          {/* One column that can't grow with its content: the OTIO dock's wide timeline made it the dock's
              width (2026-11-02: 2094 px in a 1440 px window), pushing half the DAG and the inspector off-screen. */}
          <div className={`grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] border-r border-border ${collapsed.otio ? "grid-rows-[minmax(0,1fr)_auto]" : "grid-rows-[minmax(0,1fr)_minmax(0,13rem)]"}`}>
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
