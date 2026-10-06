import { sessionLabel } from "../../lib/sessionStatus";
import { useSidecarStore } from "../../store/useSidecarStore";
import type { SessionState } from "../../types/sidecar";
import { StatusRow } from "./StatusRow";
import type { Tone } from "./StatusDot";

const SESSION_TONE: Record<SessionState, Tone> = { starting: "warn", ready: "ok", stopped: "bad" };

export function SidecarStatusRow() {
  const session = useSidecarStore((s) => s.session);
  const tone = session.state === "stopped" && !session.message ? "off" : SESSION_TONE[session.state];
  return <StatusRow label="Agent sidecar" tone={tone} value={sessionLabel(session)} detail={session.message ?? undefined} />;
}
