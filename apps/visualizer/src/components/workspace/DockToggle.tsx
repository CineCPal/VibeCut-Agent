/**
 * A dock's title, which collapses the dock to its header and opens it again (T for the OTIO preview, L for
 * the log). Where the dock can't collapse (the narrow panel's tabs), just the title.
 */
import { useVisualizerStore, type DockId } from "../../store/useVisualizerStore";

export interface DockToggleProps {
  dock: DockId;
  title: string;
  /** The id of the dock's body, which the button shows and hides. */
  controls: string;
  hotkey: string;
  collapsible: boolean;
}

export function DockToggle({ dock, title, controls, hotkey, collapsible }: DockToggleProps) {
  const collapsed = useVisualizerStore((s) => s.collapsedDocks[dock]);
  const toggleDock = useVisualizerStore((s) => s.toggleDock);
  if (!collapsible) return <span className="font-sans font-semibold text-[#e6edf3]">{title}</span>;
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded font-sans font-semibold text-[#e6edf3] hover:text-white focus-visible:outline-2"
      aria-expanded={!collapsed}
      aria-controls={controls}
      title={`${collapsed ? "Show" : "Hide"} the ${title} (${hotkey})`}
      onClick={() => toggleDock(dock)}
    >
      <span aria-hidden="true" className="inline-block w-3 text-cool-grey transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}>
        ▾
      </span>
      {title}
    </button>
  );
}
