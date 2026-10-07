import { useEffect } from "react";
import { getMiniPlayer, onMiniPlayer, setMiniPlayer } from "../lib/ipc";
import { useUiStore } from "../store/useUiStore";

/** Feeds the Mini Player state (Phase 9c) from Rust into `useUiStore`: read once on mount, then each change. */
export function useMiniPlayer(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const apply = useUiStore.getState().setMiniPlayerState;
    onMiniPlayer(apply)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    getMiniPlayer()
      .then((on) => !disposed && apply(on))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Shrinks the window into the Mini Player, or expands it; the store follows from the `mini-player` event. */
export function toggleMiniPlayer(on = !useUiStore.getState().miniPlayer): Promise<void> {
  // Overlays and menus belong to the full window.
  if (on) useUiStore.setState({ overlay: null, historyOpen: false });
  useUiStore.getState().setMiniPlayerState(on);
  return setMiniPlayer(on).then(
    () => undefined,
    () => useUiStore.getState().setMiniPlayerState(!on),
  );
}
