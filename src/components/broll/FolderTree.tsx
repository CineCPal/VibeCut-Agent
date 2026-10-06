import { ChevronDown, ChevronRight } from "lucide-react";
import { setScope, toggleFolder } from "../../lib/library";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { SpyglassFolder } from "../../types/spyglass";

function FolderRows({ parent, depth, busy }: { parent: string; depth: number; busy: boolean }) {
  const folders = useLibraryStore((s) => s.children[parent]);
  const expanded = useLibraryStore((s) => s.expanded);
  const scopes = useLibraryStore((s) => s.scopes);
  if (!folders) return depth ? <li className="py-0.5 text-[11px] text-cool-grey" style={{ paddingLeft: depth * 14 + 22 }}>Loading…</li> : null;
  return (
    <>
      {folders.map((f: SpyglassFolder) => {
        const open = expanded.includes(f.path);
        return (
          <li key={f.path}>
            <div className="flex items-center gap-1 py-0.5 pr-1" style={{ paddingLeft: depth * 14 }}>
              {f.hasChildren ? (
                <button
                  type="button"
                  className="rounded p-0.5 text-cool-grey hover:text-white"
                  aria-expanded={open}
                  aria-label={`${open ? "Close" : "Open"} ${f.name}`}
                  onClick={() => void toggleFolder(f.path)}
                >
                  {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                </button>
              ) : (
                <span className="w-[20px]" />
              )}
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs" title={f.path}>
                <input
                  type="checkbox"
                  className="accent-athletic-blue-light"
                  checked={scopes.includes(f.path)}
                  disabled={busy}
                  onChange={(e) => void setScope(f.path, e.target.checked)}
                />
                <span className={`truncate ${f.online ? "text-white" : "text-cool-grey"}`}>
                  {f.name}
                  {f.online ? "" : " (offline)"}
                </span>
              </label>
              <span className="font-mono text-[11px] text-cool-grey">{f.shotCount}</span>
            </div>
            {open ? (
              <ul>
                <FolderRows parent={f.path} depth={depth + 1} busy={busy} />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

/** Spyglass's folders; ticked ones are the scope for the Library's searches and the agent's find_broll. */
export function FolderTree() {
  const busy = useLibraryStore((s) => s.busy !== null);
  return (
    <ul aria-label="Spyglass folders" className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface px-1.5 py-1">
      <FolderRows parent="" depth={0} busy={busy} />
    </ul>
  );
}
