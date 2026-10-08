import { useRef, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ListPlus, Maximize2, SendHorizontal, Square } from "lucide-react";
import { toggleMiniPlayer } from "../../hooks/useMiniPlayer";
import { CONNECTION_TONE } from "../../lib/nleStatus";
import { sendEditedMessage, stopTurn, submitMessage } from "../../lib/agent/controller";
import { MAX_QUEUE, useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { NLE_LABELS } from "../../types/nle";
import type { ChatMessage } from "../../types/agent";
import { StatusDot } from "../common/StatusDot";
import { composerBlockReason } from "../chat/Composer";
import { UsageMeter } from "../usage/UsageMeter";

/** A reply as one plain line: Markdown marks, code fences and links' targets dropped, spaces collapsed. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the bar's middle line says: what the agent is doing, else its last words. */
export function nowLine(messages: ChatMessage[], activity: string | null, busy: boolean): string {
  if (busy && activity) return activity;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message.role === "assistant" || message.role === "error") && message.text.trim()) return plainLine(message.text);
  }
  return busy ? "Working…" : "Ask VibeCut about your timeline.";
}

const iconButton = "rounded p-1 text-cool-grey hover:bg-canvas hover:text-athletic-blue-light disabled:opacity-40";

/**
 * The Mini Player (Phase 9c): the whole window as a small floating bar, like Apple Music's MiniPlayer.
 * The editor and timeline, the plan's usage, what the agent is doing or last said, and a one-line
 * message box. It shares the chat's draft and images, so expanding (the button, a double-click on the
 * bar, or ⌥⌘M) carries on where it left off. Drag the bar anywhere to move it.
 */
export function MiniPlayer() {
  const messages = useAgentStore((s) => s.messages);
  const activity = useAgentStore((s) => s.activity);
  const status = useAgentStore((s) => s.status);
  const statusDetail = useAgentStore((s) => s.statusDetail);
  const draft = useAgentStore((s) => s.draft);
  const setDraft = useAgentStore((s) => s.setDraft);
  const images = useAgentStore((s) => s.pendingImages);
  const editing = useAgentStore((s) => s.editingMessageId);
  const outsideRunning = useMcpStore((s) => s.outsideRunning > 0);
  const queued = useAgentStore((s) => s.queue.length);
  const mentions = useAgentStore((s) => s.draftMentions);
  const host = useNleStateStore(selectActiveHost);
  const hostState = useNleStateStore((s) => (host ? s.hosts[host] : null));
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = status === "thinking" || status === "stopping";
  const blocked = composerBlockReason(status, statusDetail, outsideRunning);
  // While a turn runs, Return queues the message (Phase 11b), as in the full window.
  const offline = status === "offline" || status === "error";
  const queueing = busy || outsideRunning || queued > 0;
  const canSend = !offline && !(queueing && (queued >= MAX_QUEUE || editing)) && (draft.trim().length > 0 || images.length > 0);
  const line = nowLine(messages, activity, busy);
  const where = host && hostState ? `${NLE_LABELS[host]}${hostState.timeline ? ` · ${hostState.timeline}` : ""}` : "No editor connected";

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const text = draft;
    const sent = images;
    setDraft("");
    useAgentStore.getState().setPendingImages([]);
    useAgentStore.getState().setDraftMentions([]);
    if (editing) {
      useAgentStore.getState().setEditing(null);
      void sendEditedMessage(text, sent, mentions).catch((error: unknown) => {
        useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
        if (!useAgentStore.getState().draft) setDraft(text);
      });
    } else {
      void submitMessage(text, sent, mentions).then((outcome) => {
        if (!outcome && !useAgentStore.getState().draft) setDraft(text);
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && draft) {
      event.preventDefault();
      setDraft("");
    }
  };

  // A double-click on the bar itself (not a control) expands it.
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    void toggleMiniPlayer(false);
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={onDoubleClick}
      // Rounded like the window itself (mini_player.rs CORNER_RADIUS).
      className="flex h-full select-none flex-col justify-between gap-1 rounded-[12px] border border-border bg-surface px-3 py-2"
      aria-label="VibeCut Agent mini player"
      role="region"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <StatusDot tone={hostState ? CONNECTION_TONE[hostState.status] : "off"} />
        <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-[11px] text-warm-grey" title={where}>
          {where}
        </span>
        <UsageMeter compact />
        <button type="button" className={iconButton} onClick={() => void toggleMiniPlayer(false)} aria-label="Expand to full window" title="Expand (⌥⌘M)">
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <p data-tauri-drag-region className={`truncate text-xs ${busy ? "text-athletic-blue-light" : "text-white"}`} title={line} aria-live="polite">
        {line}
      </p>
      <form className="flex items-center gap-1" onSubmit={send}>
        <label htmlFor="mini-message" className="sr-only">
          Message
        </label>
        <input
          id="mini-message"
          ref={inputRef}
          className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1 text-xs text-white placeholder:text-cool-grey disabled:opacity-60"
          placeholder={queueing && !offline ? "Queue a message…" : (blocked ?? (editing ? "Edit your last message…" : "Ask VibeCut…"))}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={offline}
          title={images.length ? `${images.length} image${images.length === 1 ? "" : "s"} will go with it` : undefined}
        />
        {images.length ? <span className="font-mono text-[10px] text-cool-grey">+{images.length}</span> : null}
        {queued ? (
          <span className="shrink-0 font-mono text-[10px] text-cool-grey" title="Sent in order when the agent finishes; expand to edit them">
            {queued} queued
          </span>
        ) : null}
        {queueing ? (
          <button type="submit" className={iconButton} disabled={!canSend} aria-label="Queue" title={queued >= MAX_QUEUE ? `At most ${MAX_QUEUE} can wait` : "Queue (Return)"}>
            <ListPlus size={14} aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className={iconButton} disabled={!canSend} aria-label="Send" title="Send (Return)">
            <SendHorizontal size={14} aria-hidden="true" />
          </button>
        )}
        {busy ? (
          <button type="button" className={iconButton} onClick={() => void stopTurn()} disabled={status === "stopping"} aria-label="Stop" title="Stop">
            <Square size={14} aria-hidden="true" />
          </button>
        ) : null}
      </form>
    </div>
  );
}
