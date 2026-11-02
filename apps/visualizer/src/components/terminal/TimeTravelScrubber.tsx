/**
 * The replay bar (visualizer-spec.md §4.2 D): a slider over [0 .. max seq]. Dragging it, or stepping
 * with "," and ".", shows every pane as the trace stood at that seq; Live goes back.
 */
import { useEffect } from "react";
import { useVisualizerStore } from "../../store/useVisualizerStore";

export function TimeTravelScrubber() {
  const max = useVisualizerStore((s) => s.live.max_seq_id);
  const cursor = useVisualizerStore((s) => s.replayCursorSeqId);
  const setCursor = useVisualizerStore((s) => s.setReplayCursor);
  const step = useVisualizerStore((s) => s.stepReplay);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (e.key === ",") step(-1);
      else if (e.key === ".") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const value = cursor ?? max;
  return (
    <div className="flex items-center gap-1.5 font-mono text-[11px] text-cool-grey">
      <button type="button" className="rounded border border-border px-1.5 hover:text-white disabled:opacity-40" onClick={() => step(-1)} disabled={max === 0 || value <= 0} aria-label="Step back one event" title="Step back (,)">
        ◂
      </button>
      <label className="flex items-center gap-1">
        <span className="sr-only">Replay position</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, max)}
          step={1}
          value={value}
          disabled={max === 0}
          onChange={(e) => setCursor(Number(e.target.value))}
          className="w-40 accent-[#4a90d9]"
          aria-valuetext={cursor === null ? `Live, seq ${max}` : `seq ${cursor} of ${max}`}
        />
      </label>
      <button type="button" className="rounded border border-border px-1.5 hover:text-white disabled:opacity-40" onClick={() => step(1)} disabled={cursor === null} aria-label="Step forward one event" title="Step forward (.)">
        ▸
      </button>
      <span className="w-24 text-right" data-testid="replay-position">
        {cursor === null ? `live · ${max}` : `${cursor} / ${max}`}
      </span>
      <button type="button" className={`rounded border px-1.5 ${cursor === null ? "border-profit text-profit" : "border-border hover:text-white"}`} onClick={() => setCursor(null)} aria-pressed={cursor === null}>
        Live
      </button>
    </div>
  );
}
