import { useId, useState } from "react";
import { Clapperboard, FileDown, FolderSearch } from "lucide-react";
import { buildBlocked, buildSelectsTimeline, exportSelectsXml } from "../../lib/broll";
import { revealInFinder } from "../../lib/ipc";
import type { Selects } from "../../lib/brollSelects";
import { useBrollStore, type SequenceOrder, type TopMode } from "../../store/useBrollStore";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { field, NumberField } from "./AnalyzerOptions";
import { JobProgress } from "./JobProgress";

const button =
  "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-athletic-blue px-3 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40";

const length = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * The selects (PLAN.md, "Phase 10"): which clips go in (all, the best N, or a minimum score), their order and
 * the sequence's name, then Export XML… (a Premiere selects reel) or Build timeline (a new timeline in the
 * connected editor, revertible). Both use exactly the clips and ticked segments summed up here.
 */
export function SelectsBar({ chosen, busy }: { chosen: Selects; busy: boolean }) {
  const { topMode, sequenceOrder, sequenceName, setOption } = useBrollStore();
  const jobs = useSidecarStore((s) => s.jobs);
  useNleStateStore((s) => s.hosts);
  useConnectionStore((s) => s.connections);
  const blocked = buildBlocked();
  const [exportJob, setExportJob] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed: boolean; path?: string } | null>(null);
  const modeId = useId();
  const orderId = useId();
  const nameId = useId();
  const job = jobs.find((j) => j.id === exportJob) ?? null;
  const running = working !== null;
  const empty = chosen.segments === 0;

  const run = async (label: string, work: () => Promise<{ text: string; path?: string } | null>) => {
    setWorking(label);
    setNotice(null);
    try {
      const done = await work();
      if (done) setNotice({ ...done, failed: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), failed: true });
    } finally {
      setWorking(null);
    }
  };

  return (
    <section aria-label="Selects" className="space-y-2 rounded-md border border-border bg-surface px-2.5 py-2">
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={modeId} className="block text-[11px] text-cool-grey">
          Include
          <select id={modeId} className={`${field} mt-0.5`} value={topMode} onChange={(e) => setOption("topMode", e.target.value as TopMode)} disabled={running}>
            <option value="all">Every clip</option>
            <option value="topn">The best N clips</option>
            <option value="threshold">Clips scoring at least</option>
          </select>
        </label>
        <label htmlFor={orderId} className="block text-[11px] text-cool-grey">
          Order
          <select id={orderId} className={`${field} mt-0.5`} value={sequenceOrder} onChange={(e) => setOption("sequenceOrder", e.target.value as SequenceOrder)} disabled={running}>
            <option value="score">Best first</option>
            <option value="name">By file name</option>
          </select>
        </label>
        {topMode === "topn" ? (
          <NumberField label="How many" name="topN" min={1} max={1000} disabled={running} />
        ) : topMode === "threshold" ? (
          <NumberField label="Minimum score" name="minScore" min={0} max={100} disabled={running} />
        ) : null}
        <label htmlFor={nameId} className={`block text-[11px] text-cool-grey ${topMode === "all" ? "col-span-2" : ""}`}>
          Sequence name
          <input
            id={nameId}
            className={`${field} mt-0.5`}
            value={sequenceName}
            maxLength={120}
            placeholder="B-Roll Selects"
            onChange={(e) => setOption("sequenceName", e.target.value)}
            disabled={running}
          />
        </label>
      </div>
      <p className="text-[11px] text-cool-grey" aria-live="polite">
        {empty ? "No segments selected." : `Selects: ${chosen.segments} segment${chosen.segments === 1 ? "" : "s"} from ${chosen.clips.length} clip${chosen.clips.length === 1 ? "" : "s"}, ${length(chosen.seconds)}`}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={empty || running || busy}
          title="Write a Premiere Pro XML: a bin of the clips and a sequence of the selects (File → Import in Premiere)"
          onClick={() => void run("export", () => exportSelectsXml(chosen, setExportJob))}
        >
          <FileDown size={14} aria-hidden="true" />
          Export XML…
        </button>
        <button
          type="button"
          className={button}
          disabled={empty || running || busy || blocked !== null}
          title={blocked ?? "Make a new timeline of the selects in the connected editor. Revert in the Agent tab takes the clips back."}
          onClick={() => void run("build", async () => ({ text: await buildSelectsTimeline(chosen, (text) => setWorking(text)) }))}
        >
          <Clapperboard size={14} aria-hidden="true" />
          Build timeline
        </button>
      </div>
      {job && working === "export" ? <JobProgress job={job} /> : null}
      {working && working !== "export" && working !== "build" ? <p className="text-[11px] text-cool-grey" role="status">{working}</p> : null}
      {notice ? (
        <div role={notice.failed ? "alert" : "status"} className={`flex items-start gap-1 text-[11px] ${notice.failed ? "text-loss" : "text-profit"}`}>
          <p className="min-w-0 flex-1 break-words">
            {notice.text}
            {notice.path ? <span className="block truncate font-mono text-cool-grey" title={notice.path}>{notice.path}</span> : null}
          </p>
          {notice.path ? (
            <button type="button" onClick={() => void revealInFinder(notice.path as string)} aria-label="Show the XML in Finder" title="Show in Finder" className="rounded p-1 text-cool-grey hover:text-athletic-blue-light">
              <FolderSearch size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
