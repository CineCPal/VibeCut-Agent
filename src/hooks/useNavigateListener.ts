import { useEffect } from "react";
import { onNavigate, takePendingView } from "../lib/ipc";
import { useUiStore } from "../store/useUiStore";

/**
 * Follows the tray menu. The view requested before this webview was listening is parked in Rust and
 * collected on mount; later ones arrive as `navigate` events (which also clear the parked copy).
 */
export function useNavigateListener(): void {
  const navigate = useUiStore((s) => s.navigate);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    takePendingView()
      .then((view) => {
        if (!disposed && view) navigate(view);
      })
      .catch(() => undefined);

    onNavigate((view) => {
      navigate(view);
      takePendingView().catch(() => undefined);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);
}
