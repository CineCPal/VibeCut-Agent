import { useEffect } from "react";
import { useUiStore } from "../store/useUiStore";
import { toggleMiniPlayer } from "./useMiniPlayer";
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

/** ⌘/Ctrl+Y: the chat's past chats. */
export function opensHistory(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "y";
}

/** ⌥⌘M (Ctrl+Alt+M): the Mini Player, as in Apple Music. `code`, since ⌥M types "µ" on a Mac. */
export function togglesMiniPlayer(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.code === "KeyM";
}

export function useHotkeys(): void {
  const navigate = useUiStore((s) => s.navigate);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (togglesMiniPlayer(event)) {
        event.preventDefault();
        void toggleMiniPlayer();
        return;
      }
      // Anything else that opens a view expands the Mini Player first.
      const expand = () => {
        if (useUiStore.getState().miniPlayer) void toggleMiniPlayer(false);
      };
      if (opensHistory(event)) {
        event.preventDefault();
        expand();
        navigate("chat");
        useUiStore.getState().setHistoryOpen(true);
        return;
      }
      const view = viewForShortcut(event);
      if (!view) return;
      event.preventDefault();
      expand();
      navigate(view);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
