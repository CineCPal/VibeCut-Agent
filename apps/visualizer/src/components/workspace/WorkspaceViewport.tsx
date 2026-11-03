/**
 * Pane A (visualizer-spec.md §4.2): the studio and the DAG side by side, or either alone (1, 2, 3). Narrower
 * than 640 px (Premiere's docked panel) the split stacks them, so each keeps the panel's width.
 */
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { DagCanvas } from "../dag/DagCanvas";
import { VirtualStudioCanvas } from "../studio/VirtualStudioCanvas";

export function WorkspaceViewport() {
  const mode = useVisualizerStore((s) => s.viewMode);
  return (
    <section className="flex h-full min-h-0 w-full flex-col sm:flex-row" aria-label="Workspace">
      {mode !== "dag" && (
        <div className={`min-h-0 min-w-0 ${mode === "split" ? "h-1/2 w-full border-b border-border sm:h-full sm:w-1/2 sm:border-b-0 sm:border-r" : "h-full w-full"}`}>
          <VirtualStudioCanvas />
        </div>
      )}
      {mode !== "studio" && (
        <div className={`min-h-0 min-w-0 ${mode === "split" ? "h-1/2 w-full sm:h-full sm:w-1/2" : "h-full w-full"}`}>
          <DagCanvas />
        </div>
      )}
    </section>
  );
}
