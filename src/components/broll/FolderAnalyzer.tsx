import { useMemo } from "react";
import { FolderOpen, RefreshCw, Search, Sparkles } from "lucide-react";
import { chooseFolder } from "../../lib/ipc";
import { placementTarget, startAnalysis, startMatch } from "../../lib/broll";
import { selectedPaths, selects } from "../../lib/brollSelects";
import { useNleStateStore } from "../../store/useNleStateStore";
import { staleOptions, useBrollStore } from "../../store/useBrollStore";
import { isActive, useSidecarStore } from "../../store/useSidecarStore";
import type { AnalyzeResult, MatchHit, MatchResult, RankedClip } from "../../types/broll";
import { AnalyzerOptions, field } from "./AnalyzerOptions";
import { ClipRow } from "./ClipRow";
import { JobProgress } from "./JobProgress";
import { SegmentPreview } from "./SegmentPreview";
import { SelectsBar } from "./SelectsBar";

const NO_CLIPS: RankedClip[] = [];
const NO_HITS: MatchHit[] = [];

const button =
  "flex items-center justify-center gap-1.5 rounded-md bg-athletic-blue px-3 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40";

/** The run's warnings and the clips that failed, folded under a count. */
function Issues({ result }: { result: { warnings: string[]; failed: { path: string; message: string }[] } }) {
  const total = result.warnings.length + result.failed.length;
  if (!total) return null;
  return (
    <details className="text-[11px] text-warning" open={total <= 2}>
      <summary className="cursor-pointer select-none">
        {total} issue{total === 1 ? "" : "s"}
        {result.failed.length ? ` · ${result.failed.length} clip(s) couldn't be analyzed` : ""}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {result.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
        {result.failed.map((f) => (
          <li key={f.path} title={f.path}>
            {f.path.split("/").pop()}: {f.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The Analyze tab (PLAN.md, Phases 4 and 10): rank a folder's clips with the B-roll analyzer, pick up to 20
 * segments per clip, preview them, then export the selects as a Premiere XML or build them into a timeline.
 * Options and the last result are remembered between runs.
 */
export function FolderAnalyzer() {
  const state = useBrollStore();
  const { folder, contentAware, dedupe, query, analyzeJobId, matchJobId, lastResult, excluded, preview } = state;
  const { setFolder, setContentAware, setDedupe, setQuery, toggleSegment, setPreview } = state;
  const jobs = useSidecarStore((s) => s.jobs);
  const analyzeJob = jobs.find((j) => j.id === analyzeJobId) ?? null;
  const matchJob = jobs.find((j) => j.id === matchJobId) ?? null;
  const analyzing = analyzeJob !== null && isActive(analyzeJob);
  const matching = matchJob !== null && isActive(matchJob);

  // Re-render when the editors' state changes, so Place follows them.
  useNleStateStore((s) => s.hosts);
  const target = placementTarget();
  const placeBlocked = typeof target === "string" ? target : null;

  // This run's result while it's fresh, else the kept one for this folder (a restart, or a cleared job list).
  const live = analyzeJob?.result as AnalyzeResult | undefined;
  const kept = lastResult && lastResult.folder === folder ? lastResult.result : undefined;
  const analysis = live && Array.isArray(live.ranked) ? live : kept;
  const stale = analysis && !analyzing ? staleOptions(state) : [];
  // Only a dedupe run marks near-duplicates, and the selects (like the analyzer's own export) leave them out.
  const skipDuplicates = true;
  const matches = (matchJob?.result as MatchResult | undefined)?.matches[0]?.results ?? NO_HITS;

  const selectOptions = { topMode: state.topMode, topN: state.topN, minScore: state.minScore, sequenceOrder: state.sequenceOrder };
  const ranked = analysis?.ranked ?? NO_CLIPS;
  const chosen = useMemo(
    () => selects(ranked, selectOptions, excluded, skipDuplicates),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranked, excluded, skipDuplicates, state.topMode, state.topN, state.minScore, state.sequenceOrder],
  );
  const inSelection = useMemo(
    () => selectedPaths(ranked, selectOptions, skipDuplicates),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranked, skipDuplicates, state.topMode, state.topN, state.minScore],
  );

  // The clip being previewed: a ranked clip, or a search hit (its matched stretch).
  const previewClip: RankedClip | null = useMemo(() => {
    if (!preview) return null;
    const clip = ranked.find((c) => c.path === preview.path);
    if (clip) return clip;
    const hit = matches.find((h) => h.path === preview.path);
    if (!hit) return null;
    return {
      path: hit.path,
      filename: hit.filename,
      score: hit.combined,
      bestStart: hit.start,
      bestEnd: hit.end,
      duration: hit.duration,
      segments: [{ start: hit.start, end: hit.end, score: hit.combined }],
      energy: null,
      relevance: null,
      duplicateOf: null,
    };
  }, [preview, ranked, matches]);

  const pick = async () => {
    const chosenFolder = await chooseFolder("Choose a folder of B-roll", folder ?? undefined).catch(() => null);
    if (chosenFolder) setFolder(chosenFolder);
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
        <AnalyzerOptions
          disabled={analyzing}
          contentAwareControls={
            <>
              <label
                className="flex items-center gap-2 text-xs text-white"
                title="Rates energy and how well each clip fits a brief, and enables search, with a local SigLIP 2 model. The first run installs about 2 GB of Python packages and downloads the model weights from Hugging Face; after that it runs offline."
              >
                <input
                  type="checkbox"
                  className="accent-athletic-blue-light"
                  checked={contentAware}
                  onChange={(e) => setContentAware(e.target.checked)}
                  disabled={analyzing}
                />
                <span className="min-w-0 truncate">
                  Content-aware scoring
                  <span className="text-[11px] text-cool-grey"> · energy, brief, search · first run ~2 GB</span>
                </span>
              </label>
              {contentAware ? (
                <label className="flex items-center gap-2 text-[11px] text-white">
                  <input
                    type="checkbox"
                    className="accent-athletic-blue-light"
                    checked={dedupe}
                    onChange={(e) => setDedupe(e.target.checked)}
                    disabled={analyzing}
                  />
                  Mark near-duplicate takes (and leave them out of the selects)
                </label>
              ) : null}
            </>
          }
        />
        <button type="button" className={`${button} w-full`} onClick={() => void startAnalysis()} disabled={!folder || analyzing}>
          <Sparkles size={14} aria-hidden="true" />
          Analyze folder
        </button>
      </section>

      {analyzeJob ? <JobProgress job={analyzeJob} /> : null}

      {previewClip && preview ? (
        <div className="sticky top-0 z-10 -mx-3 bg-canvas px-3 pb-1">
          <SegmentPreview clip={previewClip} index={preview.index} />
        </div>
      ) : null}

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
              className={`${field} py-1.5`}
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
                  onPreview={() => setPreview({ path: hit.path, index: 0 })}
                  previewing={preview?.path === hit.path && !ranked.some((c) => c.path === hit.path) ? 0 : null}
                  placeBlocked={placeBlocked}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {analysis ? (
        <section aria-label="Ranked clips" className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cool-grey">
            {analysis.ranked.length} clip(s), best first
            {analysis.cached ? ` · ${analysis.cached} from cache` : ""}
            {analysis.duplicates ? ` · ${analysis.duplicates} near-duplicate(s)` : ""}
          </h3>
          <Issues result={analysis} />
          {stale.length ? (
            <div role="status" className="flex items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-[11px] text-white">
              <span className="min-w-0 flex-1">
                Settings changed since this run ({stale.join(", ")}). Re-score to update the segments; cached clips aren't decoded again.
              </span>
              <button type="button" className={`${button} shrink-0 px-2 py-1`} onClick={() => void startAnalysis()} disabled={!folder || analyzing}>
                <RefreshCw size={12} aria-hidden="true" />
                Re-score
              </button>
            </div>
          ) : null}
          {analysis.ranked.length ? <SelectsBar chosen={chosen} busy={analyzing} /> : null}
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
                segments={clip.segments}
                excluded={excluded[clip.path] ?? []}
                onToggleSegment={(i) => toggleSegment(clip.path, i)}
                onPreview={(i) => setPreview({ path: clip.path, index: i })}
                previewing={preview?.path === clip.path ? preview.index : null}
                inSelection={inSelection.has(clip.path)}
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
