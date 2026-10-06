import { FolderOpen, Search, Sparkles } from "lucide-react";
import { chooseFolder } from "../../lib/ipc";
import { placementTarget, startAnalysis, startMatch } from "../../lib/broll";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useBrollStore } from "../../store/useBrollStore";
import { isActive, useSidecarStore } from "../../store/useSidecarStore";
import type { AnalyzeResult, MatchResult } from "../../types/broll";
import { ClipRow } from "./ClipRow";
import { JobProgress } from "./JobProgress";

const button =
  "flex items-center justify-center gap-1.5 rounded-md bg-athletic-blue px-3 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-white placeholder:text-cool-grey";

function Warnings({ result }: { result: { warnings: string[]; failed: { path: string; message: string }[] } }) {
  if (!result.warnings.length && !result.failed.length) return null;
  return (
    <ul className="space-y-0.5 text-[11px] text-warning">
      {result.warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
      {result.failed.map((f) => (
        <li key={f.path}>
          {f.path.split("/").pop()}: {f.message}
        </li>
      ))}
    </ul>
  );
}

export function FolderAnalyzer() {
  const { folder, contentAware, brief, dedupe, query, analyzeJobId, matchJobId } = useBrollStore();
  const { setFolder, setContentAware, setBrief, setDedupe, setQuery } = useBrollStore();
  const jobs = useSidecarStore((s) => s.jobs);
  const analyzeJob = jobs.find((j) => j.id === analyzeJobId) ?? null;
  const matchJob = jobs.find((j) => j.id === matchJobId) ?? null;
  const analyzing = analyzeJob !== null && isActive(analyzeJob);
  const matching = matchJob !== null && isActive(matchJob);

  // Re-render when the editors' state changes, so Place follows them.
  useNleStateStore((s) => s.hosts);
  const target = placementTarget();
  const placeBlocked = typeof target === "string" ? target : null;
  const analysis = analyzeJob?.result as AnalyzeResult | undefined;
  const matches = (matchJob?.result as MatchResult | undefined)?.matches[0]?.results ?? [];

  const pick = async () => {
    const chosen = await chooseFolder("Choose a folder of B-roll", folder ?? undefined).catch(() => null);
    if (chosen) setFolder(chosen);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <section aria-label="Folder" className="flex items-center gap-2">
        <button type="button" className={`${button} shrink-0`} onClick={() => void pick()} disabled={analyzing || matching}>
          <FolderOpen size={14} aria-hidden="true" />
          {folder ? "Change" : "Choose folder…"}
        </button>
        <span className="min-w-0 truncate font-mono text-[11px] text-cool-grey" title={folder ?? undefined}>
          {folder ?? "No folder chosen"}
        </span>
      </section>

      <section aria-label="Options" className="space-y-2 rounded-md border border-border bg-surface px-2.5 py-2">
        <label className="flex items-start gap-2 text-xs text-white">
          <input
            type="checkbox"
            className="mt-0.5 accent-athletic-blue-light"
            checked={contentAware}
            onChange={(e) => setContentAware(e.target.checked)}
            disabled={analyzing}
          />
          <span>
            Content-aware scoring
            <span className="block text-[11px] text-cool-grey">
              Rates energy and how well each clip fits a brief, and enables search, with a local SigLIP 2 model. The first run
              installs about 2 GB of Python packages and downloads the model weights from Hugging Face; after that it runs offline.
            </span>
          </span>
        </label>
        {contentAware ? (
          <>
            <label className="block text-[11px] text-cool-grey">
              Brief (optional)
              <input
                className={`${field} mt-0.5`}
                value={brief}
                maxLength={200}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="e.g. busy city streets at night"
                disabled={analyzing}
              />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-white">
              <input
                type="checkbox"
                className="accent-athletic-blue-light"
                checked={dedupe}
                onChange={(e) => setDedupe(e.target.checked)}
                disabled={analyzing}
              />
              Mark near-duplicate takes
            </label>
          </>
        ) : null}
        <button type="button" className={`${button} w-full`} onClick={() => void startAnalysis()} disabled={!folder || analyzing}>
          <Sparkles size={14} aria-hidden="true" />
          Analyze folder
        </button>
      </section>

      {analyzeJob ? <JobProgress job={analyzeJob} /> : null}

      {contentAware ? (
        <section aria-label="Search" className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void startMatch();
            }}
          >
            <label className="sr-only" htmlFor="broll-query">
              Find shots
            </label>
            <input
              id="broll-query"
              className={field}
              value={query}
              maxLength={300}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find shots: a dog running on a beach"
              disabled={matching}
            />
            <button type="submit" className={button} disabled={!folder || !query.trim() || matching} aria-label="Search">
              <Search size={14} aria-hidden="true" />
            </button>
          </form>
          {matchJob ? <JobProgress job={matchJob} /> : null}
          {matches.length ? (
            <ul aria-label="Search results" className="divide-y divide-border">
              {matches.map((hit) => (
                <ClipRow
                  key={hit.path}
                  path={hit.path}
                  filename={hit.filename}
                  score={hit.combined}
                  start={hit.start}
                  end={hit.end}
                  duration={hit.duration}
                  chips={[`match ${Math.round(hit.relative)}`, hit.technical === null ? null : `quality ${Math.round(hit.technical)}`]}
                  placeBlocked={placeBlocked}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {analysis ? (
        <section aria-label="Ranked clips" className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cool-grey">
            {analysis.ranked.length} clip(s), best first
            {analysis.cached ? ` · ${analysis.cached} from cache` : ""}
            {analysis.duplicates ? ` · ${analysis.duplicates} near-duplicate(s)` : ""}
          </h3>
          <Warnings result={analysis} />
          <ul aria-label="Clips" className="divide-y divide-border">
            {analysis.ranked.map((clip) => (
              <ClipRow
                key={clip.path}
                path={clip.path}
                filename={clip.filename}
                score={clip.score}
                start={clip.bestStart}
                end={clip.bestEnd}
                duration={clip.duration}
                chips={[
                  clip.energy === null ? null : `energy ${Math.round(clip.energy)}`,
                  clip.relevance === null ? null : `brief ${Math.round(clip.relevance)}`,
                ]}
                note={clip.duplicateOf ? `Near-duplicate of ${clip.duplicateOf.split("/").pop()}` : null}
                placeBlocked={placeBlocked}
              />
            ))}
          </ul>
        </section>
      ) : !analyzeJob && !folder ? (
        <p className="px-4 pt-6 text-center text-xs text-cool-grey">
          Choose a folder of footage to rank its clips by sharpness, exposure and stability, and find the best few seconds of each.
        </p>
      ) : null}
    </div>
  );
}
