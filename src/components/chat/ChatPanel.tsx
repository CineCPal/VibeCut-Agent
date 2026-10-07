import { useState } from "react";
import { SquarePen, Undo2 } from "lucide-react";
import { lastTurnEdits, newConversation, retryLastTurn, rewindBlockReason, startEditingLastMessage } from "../../lib/agent/controller";
import { revertLastRequest } from "../../lib/agent/edits";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useMcpStore } from "../../store/useMcpStore";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import type { AgentStatus } from "../../types/agent";
import { AI_CHOICES } from "../../types/agent";
import { StatusDot, type Tone } from "../common/StatusDot";
import { ChatHistoryMenu } from "./ChatHistoryMenu";
import { Composer } from "./Composer";
import { DraftBar } from "./DraftBar";
import { MessageList, type TurnActions } from "./MessageList";

const STATUS_TONE: Record<AgentStatus, Tone> = { offline: "off", idle: "ok", thinking: "warn", stopping: "warn", error: "bad" };
const STATUS_TEXT: Record<AgentStatus, string> = {
  offline: "Offline",
  idle: "Ready",
  thinking: "Working",
  stopping: "Stopping",
  error: "Error",
};

export function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const status = useAgentStore((s) => s.status);
  const aiChoice = useAgentStore((s) => s.aiChoice);
  const activity = useAgentStore((s) => s.activity);
  const model = AI_CHOICES.find((c) => c.id === aiChoice)?.label ?? aiChoice;
  const running = status === "thinking" || status === "stopping";
  const entries = useEditLogStore((s) => s.entries);
  const step = lastEditStep(entries);
  const revertable = step.length;
  // The latest request's edits were made before the app last restarted (the saved log, Phase 8a).
  const earlier = revertable > 0 && entries.some((e) => e.id === step[0] && e.fromEarlierRun);
  const outsideRunning = useMcpStore((s) => s.outsideRunning > 0);
  const saveError = useChatHistoryStore((s) => s.saveError);
  const [reverting, setReverting] = useState(false);
  // What Retry and Edit may do (rewindBlockReason) follows this, the status, the messages, the edit log
  // and outside calls, all read above.
  const lastTurn = useAgentStore((s) => s.lastTurn);

  const retry = async () => {
    try {
      await retryLastTurn();
    } catch (error) {
      useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const turn: TurnActions | null =
    lastTurn && !running
      ? {
          userMessageId: lastTurn.userMessageId,
          blocked: reverting ? "Reverting…" : rewindBlockReason(),
          edits: lastTurnEdits().length,
          onRetry: () => void retry(),
          onEdit: () => startEditingLastMessage(),
        }
      : null;

  const revert = async () => {
    setReverting(true);
    try {
      const outcome = await revertLastRequest();
      useAgentStore.getState().addMessage({ role: "tool", text: outcome.summary });
    } catch (error) {
      useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px]">
        <span className="flex items-center gap-1.5">
          <StatusDot tone={STATUS_TONE[status]} />
          {STATUS_TEXT[status]} · <span className="font-mono">{model}</span>
        </span>
        <span className="flex items-center gap-1">
        {revertable > 0 ? (
          <button
            type="button"
            onClick={() => void revert()}
            disabled={running || reverting}
            title={
              earlier
                ? "Undo every edit of the latest request, made before the app restarted. Clips changed since are left as they are."
                : "Undo every edit of the latest request that changed the timeline"
            }
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-warning hover:bg-warning/10 disabled:opacity-40"
          >
            <Undo2 size={12} aria-hidden="true" />
            {reverting ? "Reverting…" : `Revert ${revertable} edit${revertable === 1 ? "" : "s"}${earlier ? " (earlier session)" : ""}`}
          </button>
        ) : null}
        <ChatHistoryMenu busy={running || outsideRunning} />
        {messages.length > 0 ? (
          <button
            type="button"
            onClick={() => void newConversation()}
            disabled={running}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40"
          >
            <SquarePen size={12} aria-hidden="true" />
            New chat
          </button>
        ) : null}
        </span>
      </div>
      {saveError ? <p className="px-3 pb-1 text-[11px] text-warning">{saveError}</p> : null}
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-sm text-white">No conversation yet</p>
          <p className="text-xs text-cool-grey">
            Ask about the timeline open in Premiere Pro or Resolve, or have the agent mark moments: "Put a red marker on
            every interview clip".
          </p>
        </div>
      ) : (
        <MessageList messages={messages} activity={activity} turn={turn} />
      )}
      <DraftBar disabled={running} />
      <Composer />
    </div>
  );
}
