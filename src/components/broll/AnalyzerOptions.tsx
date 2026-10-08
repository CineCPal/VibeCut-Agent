import { useEffect, useId, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useBrollStore, type AnalyzerOptions as Options } from "../../store/useBrollStore";

export const field = "w-full rounded-md border border-border bg-canvas px-2 py-1 text-xs text-white placeholder:text-cool-grey disabled:opacity-50";

type NumberKey = { [K in keyof Options]: Options[K] extends number | null ? K : never }[keyof Options];

/** A number option. Typing is free; the value is checked and clamped (useBrollStore) on Enter or leaving the field. */
export function NumberField({
  label,
  name,
  step = 1,
  min,
  max,
  unit,
  hint,
  disabled,
}: {
  label: string;
  name: NumberKey;
  step?: number;
  min: number;
  max: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const value = useBrollStore((s) => s[name]);
  const setOption = useBrollStore((s) => s.setOption);
  const shown = (v: number | null) => (v === null ? "" : String(v));
  const [draft, setDraft] = useState(shown(value));
  useEffect(() => setDraft(shown(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) setDraft(shown(value));
    else {
      setOption(name, parsed as Options[NumberKey]);
      // The store may clamp it; show what it kept.
      setDraft(shown(useBrollStore.getState()[name]));
    }
  };

  return (
    <div className="text-[11px] text-cool-grey" title={hint}>
      <label htmlFor={id} className="block">
        {label}
      </label>
      <span className="mt-0.5 flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={`${field} font-mono`}
          value={draft}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        {unit ? <span aria-hidden="true" className="shrink-0 text-[11px] text-cool-grey">{unit}</span> : null}
      </span>
    </div>
  );
}

/**
 * The analysis options (PLAN.md, "Phase 10"): how long each segment is, how many a clip may give and how far
 * apart, then, folded, the content-aware weights and the worker count. All are remembered between runs.
 */
/** `contentAwareControls` (the content-aware switch and its near-duplicates option) go between the segment fields and Advanced. */
export function AnalyzerOptions({ disabled, contentAwareControls }: { disabled: boolean; contentAwareControls?: ReactNode }) {
  const contentAware = useBrollStore((s) => s.contentAware);
  const brief = useBrollStore((s) => s.brief);
  const setBrief = useBrollStore((s) => s.setBrief);
  const workers = useBrollStore((s) => s.workers);
  const setOption = useBrollStore((s) => s.setOption);
  const resetOptions = useBrollStore((s) => s.resetOptions);
  const autoId = useId();

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Segment length" name="windowSec" step={0.5} min={0.5} max={120} unit="s" disabled={disabled} hint="How long each picked stretch is (0.5 to 120 seconds)" />
        <NumberField label="Segments per clip" name="maxSegments" min={1} max={20} disabled={disabled} hint="Up to this many stretches per clip. After the best one, only stretches better than the clip's average are kept." />
        <NumberField label="Gap between" name="minGapSec" step={0.5} min={0} max={30} unit="s" disabled={disabled} hint="The least space between two segments of one clip (0 to 30 seconds)" />
      </div>
      {contentAwareControls}
      <details className="group text-[11px] text-cool-grey">
        <summary className="cursor-pointer select-none truncate hover:text-white">
          Advanced
          {/* A brief still counts when this is folded, so say so. */}
          {contentAware && brief.trim() ? <span className="text-cool-grey"> · brief: {brief.trim()}</span> : null}
        </summary>
        <div className="mt-2 space-y-2">
          {contentAware ? (
            <label className="block">
              Brief (optional)
              <input
                className={`${field} mt-0.5`}
                value={brief}
                maxLength={200}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="e.g. busy city streets at night"
                disabled={disabled}
              />
            </label>
          ) : null}
          {contentAware ? (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Energy weight" name="energyWeight" min={0} max={100} unit="%" disabled={disabled} hint="How much energy counts against technical quality (0 ignores it, 100 uses energy only)" />
              <NumberField
                label="Brief weight"
                name="relevanceWeight"
                min={0}
                max={100}
                unit="%"
                disabled={disabled || !brief.trim()}
                hint={brief.trim() ? "How much the match to the brief counts" : "Write a brief to weigh it"}
              />
            </div>
          ) : (
            <p>The brief and the energy and brief weights appear with content-aware scoring.</p>
          )}
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-1.5 pb-1 text-white" htmlFor={autoId}>
              <input
                id={autoId}
                type="checkbox"
                className="accent-athletic-blue-light"
                checked={workers === null}
                disabled={disabled}
                onChange={(e) => setOption("workers", e.target.checked ? null : contentAware ? 3 : 4)}
              />
              Automatic workers
            </label>
            {workers !== null ? (
              <div className="w-24">
                <NumberField label="Workers" name="workers" min={1} max={32} disabled={disabled} hint="Clips analyzed at once. Content-aware workers each load the model (about 1.5 GB)." />
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={resetOptions}
            disabled={disabled}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40"
          >
            <RotateCcw size={12} aria-hidden="true" />
            Reset to defaults
          </button>
        </div>
      </details>
    </div>
  );
}
