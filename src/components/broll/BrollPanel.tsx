import { FolderOpen, Library } from "lucide-react";
import { useLibraryStore, type BrollView } from "../../store/useLibraryStore";
import { FolderAnalyzer } from "./FolderAnalyzer";
import { LibraryPanel } from "./LibraryPanel";

const VIEWS: { id: BrollView; label: string; icon: typeof Library; hint: string }[] = [
  { id: "library", label: "Library", icon: Library, hint: "Search and browse Spyglass's index of your archive" },
  { id: "folder", label: "Folder", icon: FolderOpen, hint: "Rank the clips in a folder on disk (B-Roll Analyzer)" },
];

/** The B-Roll tab: the Spyglass Library (PLAN.md, "Phase 5") and the folder analyzer (Phase 4). */
export function BrollPanel() {
  const view = useLibraryStore((s) => s.view);
  const setView = useLibraryStore((s) => s.setView);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="B-roll source" className="flex gap-1 border-b border-border px-3 pt-2">
        {VIEWS.map(({ id, label, icon: Icon, hint }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            title={hint}
            onClick={() => setView(id)}
            className={`flex items-center gap-1.5 rounded-t-md px-2.5 py-1 text-xs ${
              view === id ? "bg-surface text-white" : "text-cool-grey hover:text-white"
            }`}
          >
            <Icon size={13} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      {view === "library" ? <LibraryPanel /> : <FolderAnalyzer />}
    </div>
  );
}
