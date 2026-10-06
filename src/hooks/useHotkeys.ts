import { useEffect } from "react";
import { useUiStore } from "../store/useUiStore";
import type { View } from "../types/system";

/** ⌘/Ctrl shortcuts → destinations. Escape is handled by `Modal`. */
const SHORTCUTS: Record<string, View> = {
  "1": "chat",
  "2": "broll",
  ",": "settings",
  i: "about",
};

export function viewForShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): View | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  return SHORTCUTS[event.key.toLowerCase()] ?? null;
}

export function useHotkeys(): void {
  const navigate = useUiStore((s) => s.navigate);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const view = viewForShortcut(event);
      if (!view) return;
      event.preventDefault();
      navigate(view);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
