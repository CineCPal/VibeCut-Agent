import { useEffect, useState, type ReactNode } from "react";
import type { HostAnalyzerClip, HostAnalyzerFile, HostAnalyzerList, HostAnalyzerOption, HostPanelJob } from "../src/types/hostPanel";
import { Check, Press } from "./Press";
import type { Transport } from "./transport";
import type { HostPanelView } from "./useHostPanel";

/**
 * The Analyze tab of the "VibeCut Agent" panel (0.20.0): the window's B-Roll Analyzer (FolderAnalyzer).
 * Choose a folder, rank its clips by sharpness, exposure and stability (and energy, a brief and
 * near-duplicates with content-aware scoring), search it by a sentence, tick the segments, then Export
 * XML or Build timeline. The app runs the analyzer and keeps the options; this shows `analyzer.json` and
 * names clips by their place in its lists. A segment opens in the editor's Source monitor (the panel
 * can't play video), and Place puts it at the playhead, revertibly.
 */

type NumberKey = Extract<HostAnalyzerOption, { value: number }>["key"];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const active = (job: HostPanelJob | null) => !!job && (job.status === "starting" || job.status === "running");

function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A job's progress, as the window's JobProgress: percentage, ETA, what it's on, and Cancel. */
function JobProgress({ job, onCancel }: { job: HostPanelJob; onCancel: () => void }) {
  if (!active(job)) {
    if (job.status === "failed") return <p role="alert" className="vc-error">{job.error}</p>;
    if (job.status === "cancelled") return <p className="vc-faint">Cancelled.</p>;
    return null;
  }
  const pct = job.fraction === null ? null : Math.round(job.fraction * 100);
  return (
    <div className="vc-job">
      <div className="vc-row">
        <span className="vc-grow vc-truncate">{job.label}</span>
        <Press className="vc-link" onClick={onCancel} aria-label={`Cancel ${job.label}`}>
          ✕
        </Press>
      </div>
      <div role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="vc-meter">
        <div className={pct === null ? "vc-meter-fill vc-level-ok vc-meter-busy" : "vc-meter-fill vc-level-ok"} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="vc-row vc-mono vc-faint">
        <span className="vc-grow vc-truncate">{job.detail ?? "Starting…"}</span>
        <span>
          {pct === null ? "" : `${pct}%`}
          {job.eta !== null ? ` · ${duration(job.eta)} left` : ""}
        </span>
      </div>
    </div>
  );
}

/** A number option: typed freely, sent on Enter or leaving the field (the app clamps it). */
function NumberField({ label, name, value, step = 1, min, max, unit, title, disabled, set }: { label: string; name: NumberKey; value: number; step?: number; min: number; max: number; unit?: string; title?: string; disabled: boolean; set: (option: HostAnalyzerOption) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed) || parsed === value) return setDraft(String(value));
    set({ key: name, value: Math.min(max, Math.max(min, parsed)) });
  };
  return (
    <label className="vc-field" title={title}>
      <span className="vc-faint">{label}</span>
      <span className="vc-row">
        <input
          className="vc-input vc-mono"
          type="number"
          value={draft}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        {unit && <span className="vc-faint">{unit}</span>}
      </span>
    </label>
  );
}

/** A text option, sent on Enter or leaving the field. */
function TextField({ label, value, placeholder, max, disabled, onCommit }: { label: string; value: string; placeholder?: string; max: number; disabled: boolean; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className="vc-field">
      <span className="vc-faint">{label}</span>
      <input className="vc-input" value={draft} maxLength={max} placeholder={placeholder} disabled={disabled} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
    </label>
  );
}

function ClipRow({ clip, index, list, file, view }: { clip: HostAnalyzerClip; index: number; list: HostAnalyzerList; file: HostAnalyzerFile; view: HostPanelView }) {
  const [chosen, setChosen] = useState(0);
  const ticks = list === "ranked";
  const busy = !!view.pending;
  const segment = clip.segments[chosen] ?? clip.segments[0];
  const range = (s: { start: number; end: number }) => `${clock(s.start)}–${clock(s.end)}`;
  return (
    <li className={clip.inSelection === false ? "vc-clip vc-clip-out" : "vc-clip"}>
      <div className="vc-row">
        <span className="vc-score" title={clip.inSelection === false ? "Score out of 100. Left out of the selects by the Include setting." : "Score out of 100"}>
          {Math.round(clip.score)}
        </span>
        <span className="vc-grow vc-truncate" title={clip.filename}>
          {clip.filename}
        </span>
        <Press className="vc-link" disabled={busy || !!file.placeBlocked} onClick={() => view.act({ type: "analyzer_source", list, clip: index, segment: chosen })} aria-label={`Open ${clip.filename} in the Source monitor`} title={file.placeBlocked ?? `Open ${range(segment)} in the editor's source viewer, In and Out marked`}>
          Source
        </Press>
        <Press className="vc-link" disabled={busy || !!file.placeBlocked} onClick={() => view.act({ type: "analyzer_place", list, clip: index, segment: chosen })} aria-label={`Place ${clip.filename} at the playhead`} title={file.placeBlocked ?? `Place ${range(segment)} at the playhead (revertible)`}>
          Place
        </Press>
        <Press className="vc-link" onClick={() => view.act({ type: "analyzer_reveal", list, clip: index })} aria-label={`Show ${clip.filename} in Finder`} title="Show in Finder">
          Finder
        </Press>
      </div>
      <p className="vc-faint vc-mono">
        best {clock(clip.start)}–{clock(clip.end)} of {clock(clip.duration)}
        {clip.chips.length ? ` · ${clip.chips.join(" · ")}` : ""}
      </p>
      {(ticks || clip.segments.length > 1) && (
        <ul className="vc-segs" aria-label={`Segments of ${clip.filename}`}>
          {clip.segments.map((s, i) => {
            const ticked = !(clip.excluded ?? []).includes(i);
            return (
              <li key={`${s.start}-${s.end}`} className={`vc-seg ${i === chosen ? "vc-seg-on" : ""} ${ticked ? "" : "vc-seg-off"}`}>
                {ticks && <input type="checkbox" checked={ticked} onChange={() => view.act({ type: "analyzer_toggle_segment", clip: index, segment: i })} aria-label={`Include ${clip.filename} ${range(s)} in the selects`} />}
                <Press className="vc-link vc-mono" onClick={() => setChosen(i)} aria-pressed={i === chosen} title="Source and Place use this segment">
                  {range(s)}
                  {s.score !== undefined && clip.segments.length > 1 ? ` · ${Math.round(s.score)}` : ""}
                </Press>
              </li>
            );
          })}
        </ul>
      )}
      {clip.note && <p className="vc-warn">{clip.note}</p>}
    </li>
  );
}

function Selects({ file, view, busy, set }: { file: HostAnalyzerFile; view: HostPanelView; busy: boolean; set: (option: HostAnalyzerOption) => void }) {
  const { options, selects } = file;
  const empty = !selects?.segments;
  const working = active(file.exportJob) || !!view.pending;
  return (
    <section className="vc-box-section" aria-label="Selects">
      <div className="vc-row vc-wrap">
        <label className="vc-field">
          <span className="vc-faint">Include</span>
          <select className="vc-select" aria-label="Include" value={options.topMode} disabled={working} onChange={(e) => set({ key: "topMode", value: e.target.value as "all" | "topn" | "threshold" })}>
            <option value="all">Every clip</option>
            <option value="topn">The best N clips</option>
            <option value="threshold">Clips scoring at least</option>
          </select>
        </label>
        <label className="vc-field">
          <span className="vc-faint">Order</span>
          <select className="vc-select" aria-label="Order" value={options.sequenceOrder} disabled={working} onChange={(e) => set({ key: "sequenceOrder", value: e.target.value as "score" | "name" })}>
            <option value="score">Best first</option>
            <option value="name">By file name</option>
          </select>
        </label>
        {options.topMode === "topn" && <NumberField label="How many" name="topN" value={options.topN} min={1} max={1000} disabled={working} set={set} />}
        {options.topMode === "threshold" && <NumberField label="Minimum score" name="minScore" value={options.minScore} min={0} max={100} disabled={working} set={set} />}
      </div>
      <TextField label="Sequence name" value={options.sequenceName} placeholder="B-Roll Selects" max={120} disabled={working} onCommit={(value) => set({ key: "sequenceName", value })} />
      <p className="vc-faint" aria-live="polite">
        {empty ? "No segments selected." : `Selects: ${plural(selects!.segments, "segment")} from ${plural(selects!.clips, "clip")}, ${clock(selects!.seconds)}`}
      </p>
      <div className="vc-row">
        <Press className="vc-btn vc-btn-primary vc-grow" disabled={empty || working || busy} onClick={() => view.act({ type: "analyzer_export" })} title="Write an XML of the selects beside the footage (Premiere: File → Import; Resolve: File → Import → Timeline)">
          Export XML
        </Press>
        <Press className="vc-btn vc-btn-primary vc-grow" disabled={empty || working || busy || !!file.buildBlocked} onClick={() => view.act({ type: "analyzer_build" })} title={file.buildBlocked ?? "Make a new timeline of the selects here. Revert in the Chat tab takes the clips back."}>
          Build timeline
        </Press>
      </div>
      {file.exportJob && <JobProgress job={file.exportJob} onCancel={() => view.act({ type: "analyzer_cancel" })} />}
    </section>
  );
}

export function AnalyzeTab({ file, view, transport }: { file: HostAnalyzerFile | null; view: HostPanelView; transport: Transport }) {
  const [typedFolder, setTypedFolder] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(file?.query ?? ""), [file?.query]);
  if (!file) return <p className="vc-muted vc-empty vc-pad">Loading the Analyzer…</p>;
  const { options } = file;
  const analyzing = active(file.analyzeJob);
  const matching = active(file.matchJob);
  const set = (option: HostAnalyzerOption) => view.act({ type: "analyzer_set_option", ...option });
  const cancel = () => view.act({ type: "analyzer_cancel" });
  const choose = async () => {
    const folder = await transport.chooseFolder?.(file.folder);
    if (folder) view.act({ type: "analyzer_set_folder", path: folder });
  };
  const section = (label: string, children: ReactNode) => (
    <section className="vc-box-section" aria-label={label}>
      {children}
    </section>
  );

  return (
    <div className="vc-analyze">
      {section(
        "Folder",
        <>
          <div className="vc-row">
            {transport.chooseFolder ? (
              <Press className="vc-btn vc-btn-primary" disabled={analyzing || matching} onClick={() => void choose()}>
                {file.folder ? "Change" : "Choose folder…"}
              </Press>
            ) : null}
            <span className="vc-grow vc-truncate vc-mono vc-faint" title={file.folder ?? undefined}>
              {file.folder ?? "No folder chosen"}
            </span>
          </div>
          {!transport.chooseFolder && (
            <div className="vc-row">
              <input className="vc-input vc-grow" value={typedFolder} placeholder="/Volumes/Footage/B-roll" aria-label="Folder path" onChange={(e) => setTypedFolder(e.target.value)} />
              <Press className="vc-btn" disabled={!typedFolder.trim().startsWith("/") || analyzing} onClick={() => view.act({ type: "analyzer_set_folder", path: typedFolder.trim() })}>
                Use
              </Press>
            </div>
          )}
        </>,
      )}

      {section(
        "Options",
        <>
          <div className="vc-row vc-wrap">
            <NumberField label="Segment length" name="windowSec" value={options.windowSec} step={0.5} min={0.5} max={120} unit="s" disabled={analyzing} set={set} title="How long each picked stretch is" />
            <NumberField label="Segments per clip" name="maxSegments" value={options.maxSegments} min={1} max={20} disabled={analyzing} set={set} title="Up to this many stretches per clip" />
            <NumberField label="Gap between" name="minGapSec" value={options.minGapSec} step={0.5} min={0} max={30} unit="s" disabled={analyzing} set={set} title="The least space between two segments of one clip" />
          </div>
          <Check className="vc-check" checked={file.contentAware} disabled={analyzing} onChange={(value) => set({ key: "contentAware", value })} title="Rates energy and how well each clip fits a brief, and enables search, with a local SigLIP 2 model. The first run installs about 2 GB.">
            Content-aware scoring <span className="vc-faint">· energy, brief, search</span>
          </Check>
          {file.contentAware && (
            <Check className="vc-check" checked={file.dedupe} disabled={analyzing} onChange={(value) => set({ key: "dedupe", value })}>
              Mark near-duplicate takes (and leave them out of the selects)
            </Check>
          )}
          <details className="vc-details">
            <summary>
              Advanced{file.contentAware && file.brief.trim() ? <span className="vc-faint"> · brief: {file.brief.trim()}</span> : null}
            </summary>
            {file.contentAware ? (
              <>
                <TextField label="Brief (optional)" value={file.brief} placeholder="e.g. busy city streets at night" max={200} disabled={analyzing} onCommit={(value) => set({ key: "brief", value })} />
                <div className="vc-row vc-wrap">
                  <NumberField label="Energy weight" name="energyWeight" value={options.energyWeight} min={0} max={100} unit="%" disabled={analyzing} set={set} />
                  <NumberField label="Brief weight" name="relevanceWeight" value={options.relevanceWeight} min={0} max={100} unit="%" disabled={analyzing || !file.brief.trim()} set={set} />
                </div>
              </>
            ) : (
              <p className="vc-faint">The brief and the energy and brief weights appear with content-aware scoring.</p>
            )}
            <div className="vc-row">
              <Check className="vc-check" checked={options.workers === null} disabled={analyzing} onChange={(auto) => set({ key: "workers", value: auto ? null : file.contentAware ? 3 : 4 })}>
                Automatic workers
              </Check>
              {options.workers !== null && (
                <label className="vc-field">
                  <span className="vc-faint">Workers</span>
                  <input
                    className="vc-input vc-mono"
                    type="number"
                    min={1}
                    max={32}
                    defaultValue={options.workers}
                    key={options.workers}
                    disabled={analyzing}
                    aria-label="Workers"
                    onBlur={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (n >= 1 && n <= 32 && n !== options.workers) set({ key: "workers", value: n });
                    }}
                  />
                </label>
              )}
            </div>
            <Press className="vc-link" disabled={analyzing} onClick={() => view.act({ type: "analyzer_reset_options" })}>
              Reset to defaults
            </Press>
          </details>
          <Press className="vc-btn vc-btn-primary vc-full" disabled={!file.folder || analyzing} onClick={() => view.act({ type: "analyzer_start" })}>
            Analyze folder
          </Press>
        </>,
      )}

      {file.analyzeJob && <JobProgress job={file.analyzeJob} onCancel={cancel} />}

      {file.contentAware &&
        section(
          "Search",
          <>
            <div className="vc-row">
              <input
                className="vc-input vc-grow"
                value={query}
                maxLength={300}
                placeholder="Find shots: a dog running on a beach"
                aria-label="Find shots"
                disabled={matching}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && query.trim() && file.folder && view.act({ type: "analyzer_match", query: query.trim() })}
              />
              <Press className="vc-btn" disabled={!file.folder || !query.trim() || matching} onClick={() => view.act({ type: "analyzer_match", query: query.trim() })} aria-label="Search">
                Search
              </Press>
            </div>
            {file.matchJob && <JobProgress job={file.matchJob} onCancel={cancel} />}
            {file.matches.length > 0 && (
              <ul className="vc-clips" aria-label="Search results">
                {file.matches.map((clip, i) => (
                  <ClipRow key={`${clip.filename}-${i}`} clip={clip} index={i} list="matches" file={file} view={view} />
                ))}
              </ul>
            )}
          </>,
        )}

      {file.notice && (
        <div role={file.notice.failed ? "alert" : "status"} className={file.notice.failed ? "vc-notice vc-error" : "vc-notice vc-ok"}>
          <span>{file.notice.text}</span>
          {file.notice.exported && (
            <Press className="vc-link" onClick={() => view.act({ type: "analyzer_reveal_export" })} aria-label="Show the XML in Finder">
              Show in Finder
            </Press>
          )}
        </div>
      )}

      {file.analysis ? (
        <section aria-label="Ranked clips">
          <p className="vc-day">
            {plural(file.analysis.total, "clip")}, best first
            {file.analysis.cached ? ` · ${file.analysis.cached} from cache` : ""}
            {file.analysis.duplicates ? ` · ${file.analysis.duplicates} near-duplicate(s)` : ""}
          </p>
          {file.analysis.issues.length > 0 && (
            <details className="vc-details vc-warn" open={file.analysis.issues.length <= 2}>
              <summary>{plural(file.analysis.issues.length, "issue")}</summary>
              <ul className="vc-list">
                {file.analysis.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </details>
          )}
          {file.analysis.stale.length > 0 && (
            <div role="status" className="vc-row vc-stale">
              <span className="vc-grow">Settings changed since this run ({file.analysis.stale.join(", ")}). Re-score to update the segments.</span>
              <Press className="vc-btn" disabled={!file.folder || analyzing} onClick={() => view.act({ type: "analyzer_start" })}>
                Re-score
              </Press>
            </div>
          )}
          {file.analysis.total > 0 && <Selects file={file} view={view} busy={analyzing} set={set} />}
          <ul className="vc-clips" aria-label="Clips">
            {file.analysis.ranked.map((clip, i) => (
              <ClipRow key={`${clip.filename}-${i}`} clip={clip} index={i} list="ranked" file={file} view={view} />
            ))}
          </ul>
          {file.analysis.total > file.analysis.ranked.length && <p className="vc-faint">The best {file.analysis.ranked.length} are listed here; the app's Analyze tab has them all.</p>}
        </section>
      ) : !file.analyzeJob && !file.folder ? (
        <p className="vc-muted vc-empty">Choose a folder of footage to rank its clips by sharpness, exposure and stability, and find the best few seconds of each.</p>
      ) : null}
    </div>
  );
}
