import { AtSign, ImageIcon, Pause, Pencil, X } from "lucide-react";
import { editQueued, resumeQueue } from "../../lib/agent/controller";
import { useAgentStore } from "../../store/useAgentStore";

const smallButton = "rounded p-0.5 text-cool-grey hover:text-white focus-visible:text-white disabled:opacity-40";

/** Messages waiting their turn (Phase 11b), above the composer: each can be taken back to edit or removed. */
export function QueueList() {
  const queue = useAgentStore((s) => s.queue);
  const paused = useAgentStore((s) => s.queuePaused);
  const draftBusy = useAgentStore((s) => Boolean(s.draft.trim() || s.pendingImages.length || s.editingMessageId));
  if (!queue.length) return null;
  return (
    <section aria-label="Queued messages" className="mb-1.5 rounded-md border border-border bg-canvas px-2 py-1">
      {paused ? (
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-warning">
          <Pause size={11} aria-hidden="true" />
          <span className="flex-1">Held after the last request stopped. Send them when you&rsquo;re ready.</span>
          <button type="button" onClick={resumeQueue} className="rounded px-1 text-athletic-blue-light hover:text-white">
            Send next
          </button>
          <button type="button" onClick={() => useAgentStore.getState().clearQueue()} className="rounded px-1 text-cool-grey hover:text-white">
            Clear
          </button>
        </div>
      ) : (
        <p className="mb-0.5 text-[11px] text-cool-grey">Queued · sent in order when the agent finishes</p>
      )}
      <ol className="space-y-0.5">
        {queue.map((message, index) => (
          <li key={message.id} className="flex items-center gap-1.5 text-xs text-warm-grey">
            <span className="w-3 shrink-0 text-right font-mono text-[10px] text-cool-grey">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate" title={message.text}>
              {message.text.trim() || "(images)"}
            </span>
            {message.images.length ? (
              <span className="flex items-center gap-0.5 text-[10px] text-cool-grey" title={`${message.images.length} image(s)`}>
                <ImageIcon size={10} aria-hidden="true" />
                {message.images.length}
              </span>
            ) : null}
            {message.mentions.length ? (
              <span className="flex items-center gap-0.5 text-[10px] text-cool-grey" title={message.mentions.map((m) => `@${m.label}`).join(", ")}>
                <AtSign size={10} aria-hidden="true" />
                {message.mentions.length}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => editQueued(message.id)}
              disabled={draftBusy}
              aria-label={`Edit queued message ${index + 1}`}
              title={draftBusy ? "Send or clear what's in the message box first" : "Take it back into the message box"}
              className={smallButton}
            >
              <Pencil size={11} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => useAgentStore.getState().removeQueued(message.id)} aria-label={`Remove queued message ${index + 1}`} className={smallButton}>
              <X size={11} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
