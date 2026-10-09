import { NotebookPen } from "lucide-react";
import { useAgentStore } from "../../store/useAgentStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { useUiStore } from "../../store/useUiStore";
import { describeTiming, useTurnTimingStore } from "../../lib/agent/turnTiming";
import type { AgentStatus } from "../../types/agent";
import { AI_CHOICES } from "../../types/agent";
import { StatusDot, type Tone } from "../common/StatusDot";

const STATUS_TONE: Record<AgentStatus, Tone> = { offline: "off", idle: "ok", thinking: "warn", stopping: "warn", error: "bad" };
const STATUS_TEXT: Record<AgentStatus, string> = {
  offline: "Offline",
  idle: "Ready",
  thinking: "Working",
  stopping: "Stopping",
  error: "Error",
};

/** The window's bottom line, on every tab: the agent's state and the model it chats with (Settings → Agent model). */
export function StatusBar() {
  const status = useAgentStore((s) => s.status);
  const aiChoice = useAgentStore((s) => s.aiChoice);
  const model = AI_CHOICES.find((c) => c.id === aiChoice)?.label ?? aiChoice;
  // How long the last reply took to start (Phase 11f).
  const timing = useTurnTimingStore((s) => s.last);
  const timingText = timing ? `Last reply: ${describeTiming(timing)}` : undefined;
  // The project notes (Phase 13c) belong to the editor project open now.
  const project = useNleStateStore((s) => {
    const host = selectActiveHost(s);
    return host ? s.hosts[host].project : null;
  });
  const openOverlay = useUiStore((s) => s.openOverlay);
  return (
    <footer aria-label="Agent status" className="flex items-center gap-1.5 border-t border-border px-3 py-1 text-[11px] text-cool-grey">
      <StatusDot tone={STATUS_TONE[status]} />
      <span role="status" className="text-white" title={timingText}>
        {STATUS_TEXT[status]}
      </span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono" title="The agent's model (Settings → Agent model)">
        {model}
      </span>
      <button
        type="button"
        onClick={() => openOverlay("notes")}
        disabled={!project}
        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40"
        title={project ? `What the agent remembers about "${project}" (⌘⇧N)` : "Project notes: open a project in Premiere or Resolve"}
      >
        <NotebookPen size={11} aria-hidden="true" />
        Notes
      </button>
    </footer>
  );
}
