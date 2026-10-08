/**
 * Done notifications (Phase 11e): when a turn ends, fails, or a change waits for review, and the window
 * is hidden or behind another app (the editor, usually), macOS shows a notification. Local only:
 * nothing is sent anywhere. Off in Settings → General.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useNotifyStore } from "../store/useNotifyStore";

/** A macOS system sound, when the sound is on. */
const SOUND = "Glass";
const BODY_CHARS = 120;

/** Whether the window can't be seen right now: hidden in the menu bar, or another app is in front. */
export async function windowIsAway(): Promise<boolean> {
  const window = getCurrentWindow();
  const [visible, focused] = await Promise.all([window.isVisible(), window.isFocused()]);
  return !visible || !focused;
}

/** One line for a notification: the first line of `text`, without Markdown marks, cut to BODY_CHARS. */
export function notificationLine(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#>]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  return line.length > BODY_CHARS ? `${line.slice(0, BODY_CHARS - 1)}…` : line;
}

/** Shows a notification when it's on and the window is away. Never throws; quietly does nothing when it can't. */
export function notifyAway(title: string, body: string): void {
  const { enabled, sound } = useNotifyStore.getState();
  if (!enabled) return;
  void (async () => {
    try {
      if (!(await windowIsAway()) || !(await isPermissionGranted())) return;
      sendNotification({ title, body: notificationLine(body), ...(sound ? { sound: SOUND } : {}) });
    } catch {
      // No notification support here (a test, a browser): nothing to do.
    }
  })();
}

/** Turns notifications on, asking macOS for permission the first time. Answers whether they can show. */
export async function enableNotifications(): Promise<boolean> {
  useNotifyStore.getState().setEnabled(true);
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}
