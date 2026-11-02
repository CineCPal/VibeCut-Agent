import { useEffect, useState } from "react";

/** A counter that ticks `fps` times a second while `active` (one interval per caller). */
export function useTicker(fps: number, active = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || fps <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000 / fps);
    return () => clearInterval(id);
  }, [fps, active]);
  return tick;
}

/** Date.now(), refreshed every `ms` while `active`, for live elapsed times. */
export function useNow(ms: number, active = true): number {
  const tick = useTicker(1000 / ms, active);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [tick]);
  return now;
}
