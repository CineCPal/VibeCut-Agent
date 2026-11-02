import { useEffect } from "react";
import { refreshAgentStatus } from "../lib/agent/availability";
import { startAgentService } from "../lib/agent/controller";
import { useAgentStore } from "../store/useAgentStore";
import { useSidecarStore } from "../store/useSidecarStore";
import { useSystemStore } from "../store/useSystemStore";

/** Runs the agent's event service and keeps its availability current (sidecar, API keys, Claude Code, model). */
export function useAgent(): void {
  useEffect(() => startAgentService(), []);

  const session = useSidecarStore((s) => s.session);
  const keys = useSystemStore((s) => s.keys);
  const claudeCode = useSystemStore((s) => s.claudeCode);
  const aiChoice = useAgentStore((s) => s.aiChoice);
  useEffect(() => {
    refreshAgentStatus();
  }, [session, keys, claudeCode, aiChoice]);
}
