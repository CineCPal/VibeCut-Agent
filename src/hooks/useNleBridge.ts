import { useEffect } from "react";
import { getNleState, onNleState } from "../lib/ipc";
import { useNleStateStore } from "../store/useNleStateStore";

/** Feeds both editors' state from Rust into `useNleStateStore`: read once on mount, then each push. */
export function useNleBridge(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const apply = useNleStateStore.getState().applyState;

    onNleState(apply)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    getNleState()
      .then((states) => {
        if (!disposed) states.forEach(apply);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
