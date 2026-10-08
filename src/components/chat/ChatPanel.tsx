import { useState, type DragEvent } from "react";
import { SquarePen, Undo2 } from "lucide-react";
import { lastTurnEdits, newConversation, retryLastTurn, rewindBlockReason, startEditingLastMessage } from "../../lib/agent/controller";
import { revertLastRequest } from "../../lib/agent/edits";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useMcpStore } from "../../store/useMcpStore";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import { ChatHistoryMenu } from "./ChatHistoryMenu";
import { Composer, attachImages } from "./Composer";
import { imageFiles } from "../../lib/agent/attachments";
import { DraftBar } from "./DraftBar";
import { MessageList, type TurnActions } from "./MessageList";

export function ChatPanel() {
  const messages = useAgentStore((s) => s.messages);
  const status = useAgentStore((s) => s.status);
  const activity = useAgentStore((s) => s.activity);
  const running = status === "thinking" || status === "stopping";
  const entries = useEditLogStore((s) => s.entries);
  const step = lastEditStep(entries);
  const revertable = step.length;
  // The latest request's edits were made before the app last restarted (the saved log, Phase 8a).
  const earlier = revertable > 0 && entries.some((e) => e.id === step[0] && e.fromEarlierRun);
  const outsideRunning = useMcpStore((s) => s.outsideRunning > 0);
  const saveError = useChatHistoryStore((s) => s.saveError);
  const [reverting, setReverting] = useState(false);
  // Images dragged over the chat (Phase 8g): an outline while over it, then into the composer.
  const [dropping, setDropping] = useState(false);
  const [dropProblem, setDropProblem] = useState<string | null>(null);
  const takesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (event: DragEvent) => {
    if (!takesFiles(event) || status === "offline" || status === "error") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDrop = (event: DragEvent) => {
    setDropping(false);
    if (!takesFiles(event)) return;
    event.preventDefault();
    const files = imageFiles(event.dataTransfer.files);
    if (!files.length) {
      setDropProblem("Only images can be dropped here");
      return;
    }
    void attachImages(files).then(setDropProblem);
  };
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
    <div
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
      className={`relative flex min-h-0 flex-1 flex-col ${dropping ? "outline-2 -outline-offset-2 outline-dashed outline-athletic-blue-light" : ""}`}
    >
      {dropping ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 z-10 text-center text-sm text-athletic-blue-light">Drop images to send them</p>
      ) : null}
      {/* The agent's state and model are on the window's status bar (StatusBar). */}
      <div className="flex items-center justify-end px-3 py-1.5 text-[11px]">
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
      {dropProblem ? (
        <p role="alert" className="flex items-center justify-between px-3 pb-1 text-[11px] text-warning">
          {dropProblem}
          <button type="button" onClick={() => setDropProblem(null)} className="text-cool-grey hover:text-white">
            Dismiss
          </button>
        </p>
      ) : null}
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-sm text-white">No conversation yet</p>
          <p className="text-xs text-cool-grey">
            Ask about the timeline open in Premiere Pro or Resolve, or have the agent mark moments: "Put a red marker on
            every interview clip".
          </p>
        </div>
      ) : (
        <MessageList messages={messages} activity={activity} turn={turn} busy={running} />
      )}
      <DraftBar disabled={running} />
      <Composer />
    </div>
  );
}
