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
      className="group flex items-center gap-2 rounded py-0.5 font-sans font-semibold text-[#e6edf3] hover:text-white focus-visible:outline-2"
      aria-expanded={!collapsed}
      aria-controls={controls}
      title={`${collapsed ? "Show" : "Hide"} the ${title} (${hotkey})`}
      onClick={() => toggleDock(dock)}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-canvas text-cool-grey transition-transform group-hover:border-cool-grey group-hover:text-white"
        style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
      >
        <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </span>
      {title}
    </button>
  );
}
