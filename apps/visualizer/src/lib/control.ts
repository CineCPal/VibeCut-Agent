/**
 * The app's actions from the visualizer (PLAN.md, Phase 22): Cancel a chat's run, show a file in Finder, and
 * move the editor's playhead. Each goes to the gateway's control endpoint, which hands it to the app when the
 * app started that gateway (`app_control` in its health); a gateway run from a terminal can't reach the app.
 */
import { useCallback, useState } from "react";
import { selectView, useVisualizerStore, type AppAction } from "../store/useVisualizerStore";

/** A chat's trace (bus.trace_id_for("mcp", job id)): the only kind Cancel can stop. */
export const CHAT_TRACE = /^trc_mcp_[A-Za-z0-9-]{1,48}_[0-9a-f]{6}$/;

export interface AppControl {
  /** Whether the app's actions reach the app right now. */
  available: boolean;
  /** What the last action said: sent, or why it wasn't. */
  notice: string | null;
  send: (action: AppAction, params?: Record<string, unknown>, sent?: string) => void;
}

export function useAppControl(): AppControl {
  const sendControl = useVisualizerStore((s) => s.sendControl);
  const appControl = useVisualizerStore((s) => s.hostHealth?.app_control === true);
  const traceId = useVisualizerStore((s) => selectView(s).trace_id);
  const [notice, setNotice] = useState<string | null>(null);
  const available = appControl && sendControl !== null && traceId !== null;
  const send = useCallback(
    (action: AppAction, params?: Record<string, unknown>, sent = "Sent to VibeCut Agent") => {
      if (!sendControl || !traceId) return;
      sendControl(traceId, action, params)
        .then(() => setNotice(sent))
        .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
    },
    [sendControl, traceId],
  );
  return { available, notice, send };
}
