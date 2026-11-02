/**
 * Pane A (visualizer-spec.md §4.2): the studio and the DAG side by side, or either alone (1, 2, 3).
 */
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { DagCanvas } from "../dag/DagCanvas";
import { VirtualStudioCanvas } from "../studio/VirtualStudioCanvas";

export function WorkspaceViewport() {
  const mode = useVisualizerStore((s) => s.viewMode);
  return (
    <section className="flex h-full min-h-0 w-full" aria-label="Workspace">
      {mode !== "dag" && (
        <div className={`h-full min-w-0 ${mode === "split" ? "w-1/2 border-r border-border" : "w-full"}`}>
          <VirtualStudioCanvas />
        </div>
      )}
      {mode !== "studio" && (
        <div className={`h-full min-w-0 ${mode === "split" ? "w-1/2" : "w-full"}`}>
          <DagCanvas />
        </div>
      )}
    </section>
  );
}
