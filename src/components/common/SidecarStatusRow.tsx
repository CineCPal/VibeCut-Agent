import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { restartSession } from "../../lib/ipc";
import { sessionLabel } from "../../lib/sessionStatus";
import { useSidecarStore } from "../../store/useSidecarStore";
import type { SessionState } from "../../types/sidecar";
import { StatusRow } from "./StatusRow";
import type { Tone } from "./StatusDot";

const SESSION_TONE: Record<SessionState, Tone> = { starting: "warn", ready: "ok", stopped: "bad" };

/** The agent sidecar's state, with Restart (About; Settings had its own section before Phase 11a). */
export function SidecarStatusRow() {
  const session = useSidecarStore((s) => s.session);
  const [restartError, setRestartError] = useState<string | null>(null);
  const tone = session.state === "stopped" && !session.message ? "off" : SESSION_TONE[session.state];

  const restart = () => {
    setRestartError(null);
    restartSession().catch((error: unknown) => setRestartError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <StatusRow
      label="Agent sidecar"
      tone={tone}
      value={sessionLabel(session)}
      detail={restartError ? <span className="text-loss">{restartError}</span> : (session.message ?? undefined)}
      action={
        <button
          type="button"
          onClick={restart}
          aria-label="Restart the agent sidecar"
          title="Restart the agent sidecar"
          className="rounded p-0.5 text-athletic-blue-light hover:text-white"
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      }
    />
  );
}
