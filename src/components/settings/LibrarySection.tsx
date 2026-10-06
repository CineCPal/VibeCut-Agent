import { useEffect, useState } from "react";
import { FolderSearch, RotateCcw } from "lucide-react";
import { chooseFile } from "../../lib/ipc";
import { refreshIndex, reloadLibrary } from "../../lib/library";
import { chooseSpyglassIndex } from "../../lib/spyglassIpc";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { SpyglassIndexSource } from "../../types/spyglass";
import { Section } from "../common/Section";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

export const INDEX_SOURCE: Record<SpyglassIndexSource, string> = {
  environment: "from VIBECUT_SPYGLASS_INDEX",
  chosen: "chosen here",
  default: "Spyglass's own folder",
};

/**
 * Settings > B-roll Library: which Spyglass index the Library and the agent's find_broll read. A suite
 * such as Rough Cut Studio Suite - Blair Themed keeps its own index, so it can be chosen here; the
 * choice is saved in the app's config folder. VIBECUT_SPYGLASS_INDEX (a dev shell) still wins.
 */
export function LibrarySection() {
  const index = useLibraryStore((s) => s.index);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (useLibraryStore.getState().index === undefined) void refreshIndex();
  }, []);

  const apply = async (path: string | null) => {
    setBusy(true);
    setError(null);
    try {
      useLibraryStore.getState().set({ index: await chooseSpyglassIndex(path) });
      await reloadLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const path = await chooseFile("Choose Spyglass's index", ["sqlite"], index?.path).catch(() => null);
    if (path) await apply(path);
  };

  return (
    <Section
      title="B-roll Library"
      action={
        <div className="flex gap-1">
          {index?.chosen ? (
            <button type="button" className={linkButton} disabled={busy} onClick={() => void apply(null)}>
              <RotateCcw size={12} aria-hidden="true" />
              Forget choice
            </button>
          ) : null}
          <button type="button" className={linkButton} disabled={busy} onClick={() => void choose()}>
            <FolderSearch size={12} aria-hidden="true" />
            Choose index…
          </button>
        </div>
      }
    >
      <p className="text-xs text-white">{index ? "Spyglass index (read only)" : index === null ? "No Spyglass index found" : "Looking for Spyglass's index…"}</p>
      {index ? (
        <p className="mt-0.5 break-all font-mono text-[11px] text-cool-grey">
          {index.path} · {INDEX_SOURCE[index.source]}
        </p>
      ) : null}
      {index?.source === "environment" && index.chosen ? (
        <p className="mt-0.5 text-[11px] text-warning">VIBECUT_SPYGLASS_INDEX overrides the index chosen here ({index.chosen}).</p>
      ) : null}
      <p className="mt-1 text-[11px] text-cool-grey">
        The Library and the agent's find_broll read this file and never change it. The first search installs the content-aware packages and loads SigLIP 2.
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
