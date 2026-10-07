import { useId, type FormEvent, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { sendUserMessage, stopTurn } from "../../lib/agent/controller";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import type { AgentStatus } from "../../types/agent";

/** Why the composer can't send right now, or null if it can. */
export function composerBlockReason(status: AgentStatus, statusDetail: string | null, outsideRunning = false): string | null {
  if (status === "offline") return statusDetail ?? "Agent offline";
  if (status === "error") return statusDetail ?? "The agent hit an error";
  if (status === "thinking") return "Agent is working…";
  if (status === "stopping") return "Stopping…";
  if (outsideRunning) return "Claude Code is editing from outside…";
  return null;
}

export function Composer() {
  const draft = useAgentStore((s) => s.draft);
  const status = useAgentStore((s) => s.status);
  const statusDetail = useAgentStore((s) => s.statusDetail);
  const setDraft = useAgentStore((s) => s.setDraft);
  const outsideRunning = useMcpStore((s) => s.outsideRunning > 0);
  const hintId = useId();

  const blocked = composerBlockReason(status, statusDetail, outsideRunning);
  const canSend = !blocked && draft.trim().length > 0;
  const running = status === "thinking" || status === "stopping";

  const send = () => {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void sendUserMessage(text);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form onSubmit={onSubmit} className="border-t border-border bg-surface px-3 py-2">
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${hintId}-input`}>
          Message the agent
        </label>
        <textarea
          id={`${hintId}-input`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={status === "offline" || status === "error"}
          aria-describedby={hintId}
          placeholder={status === "offline" || status === "error" ? (blocked ?? "") : "Ask the agent about your timeline…"}
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-white placeholder:text-cool-grey disabled:cursor-not-allowed disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            onClick={() => void stopTurn()}
            disabled={status === "stopping"}
            aria-label="Stop the agent"
            className="rounded-md border border-loss/60 p-2 text-loss hover:bg-loss/10 disabled:opacity-40"
          >
            <Square size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="rounded-md bg-athletic-blue p-2 text-athletic-blue-light hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <p id={hintId} className="mt-1 text-[11px] text-cool-grey">
        {blocked ?? "Enter to send · Shift+Enter for a new line"}
      </p>
    </form>
  );
}
