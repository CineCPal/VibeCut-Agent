import { useAgentStore } from "../../store/useAgentStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useSystemStore } from "../../store/useSystemStore";
import type { AgentStatus, AiChoiceId, AntigravityStatus, ClaudeCodeStatus } from "../../types/agent";
import { AI_CHOICES, KEY_ENV } from "../../types/agent";
import type { SessionStatus } from "../../types/sidecar";
import type { KeyStatus } from "../../types/system";

/**
 * Whether the agent can take a message: the sidecar is running and the chosen model's API key is set.
 * Replaces Phase 2's `agentStatusForSession`, which kept the composer blocked until this phase.
 */
export function availability(
  session: SessionStatus,
  keys: KeyStatus | null,
  choiceId: AiChoiceId,
  claudeCode: ClaudeCodeStatus | null = null,
  antigravity: AntigravityStatus | null = null,
): { status: AgentStatus; detail: string | null } {
  if (session.state === "starting") return { status: "offline", detail: "Starting the agent sidecar…" };
  if (session.state === "stopped") return { status: "error", detail: session.message ?? "The agent sidecar stopped" };
  const choice = AI_CHOICES.find((c) => c.id === choiceId) ?? AI_CHOICES[0];
  if (choice.provider === "claude-code") {
    // Claude (subscription), Phase 7b: no key, but Claude Code installed and signed in.
    if (!claudeCode) return { status: "offline", detail: "Checking Claude Code…" };
    if (!claudeCode.program || claudeCode.signedIn === false) {
      return { status: "offline", detail: `${claudeCode.detail ?? "Claude Code isn't ready."} See Settings → Claude subscription, or choose another model.` };
    }
    return { status: "idle", detail: null };
  }
  if (choice.provider === "antigravity") {
    // Gemini (subscription), Phase 17: no key, but agy installed, signed in, with VibeCut's tools added.
    if (!antigravity) return { status: "offline", detail: "Checking Antigravity…" };
    const notReady = !antigravity.program || antigravity.signedIn === false || !antigravity.toolsCurrent;
    if (notReady) {
      return { status: "offline", detail: `${antigravity.detail ?? "Antigravity isn't ready."} See Settings → Gemini subscription, or choose another model.` };
    }
    if (choice.model && antigravity.models.length > 0 && !antigravity.models.includes(choice.model)) {
      return { status: "offline", detail: `Antigravity doesn't offer ${choice.label.replace(" (subscription)", "")} on your account. Choose another model.` };
    }
    return { status: "idle", detail: null };
  }
  if (!keys) return { status: "offline", detail: "Checking API keys…" };
  if (!keys[choice.provider]) {
    return {
      status: "offline",
      detail: `Add your ${choice.provider === "gemini" ? "Gemini" : "Anthropic"} API key (${KEY_ENV[choice.provider]}) in Settings to use ${choice.label}, or choose another model.`,
    };
  }
  return { status: "idle", detail: null };
}

/** Applies `availability` to the agent store, unless a turn is running (its end applies it again). */
export function refreshAgentStatus(): void {
  const agent = useAgentStore.getState();
  if (agent.status === "thinking" || agent.status === "stopping") return;
  const system = useSystemStore.getState();
  const { status, detail } = availability(useSidecarStore.getState().session, system.keys, agent.aiChoice, system.claudeCode, system.antigravity);
  agent.setStatus(status, detail);
}
