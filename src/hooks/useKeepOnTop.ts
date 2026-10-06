import { useEffect } from "react";
import { getKeepOnTop, onKeepOnTop, setKeepOnTop } from "../lib/ipc";
import { useUiStore } from "../store/useUiStore";

/** Feeds Keep on Top of Editors from Rust into `useUiStore`: read once on mount, then each change. */
export function useKeepOnTop(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const apply = useUiStore.getState().setKeepOnTopState;
    onKeepOnTop(apply)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    getKeepOnTop()
      .then((on) => !disposed && apply(on))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Turns Keep on Top of Editors on or off; the store follows from the `keep-on-top` event. */
export function toggleKeepOnTop(on: boolean): Promise<void> {
  useUiStore.getState().setKeepOnTopState(on);
  return setKeepOnTop(on).then(
    () => undefined,
    () => useUiStore.getState().setKeepOnTopState(!on),
  );
}
