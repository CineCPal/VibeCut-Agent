import { useAgentStore } from "../../store/useAgentStore";
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
  return (
    <footer aria-label="Agent status" className="flex items-center gap-1.5 border-t border-border px-3 py-1 text-[11px] text-cool-grey">
      <StatusDot tone={STATUS_TONE[status]} />
      <span role="status" className="text-white">
        {STATUS_TEXT[status]}
      </span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono" title="The agent's model (Settings → Agent model)">
        {model}
      </span>
    </footer>
  );
}
