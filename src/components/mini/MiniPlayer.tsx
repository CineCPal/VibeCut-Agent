import { useRef, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Maximize2, SendHorizontal, Square } from "lucide-react";
import { toggleMiniPlayer } from "../../hooks/useMiniPlayer";
import { CONNECTION_TONE } from "../../lib/nleStatus";
import { sendEditedMessage, sendUserMessage, stopTurn } from "../../lib/agent/controller";
import { useAgentStore } from "../../store/useAgentStore";
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
  const host = useNleStateStore(selectActiveHost);
  const hostState = useNleStateStore((s) => (host ? s.hosts[host] : null));
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = status === "thinking" || status === "stopping";
  const blocked = composerBlockReason(status, statusDetail, outsideRunning);
  const canSend = !blocked && (draft.trim().length > 0 || images.length > 0);
  const line = nowLine(messages, activity, busy);
  const where = host && hostState ? `${NLE_LABELS[host]}${hostState.timeline ? ` · ${hostState.timeline}` : ""}` : "No editor connected";

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const text = draft;
    const sent = images;
    setDraft("");
    useAgentStore.getState().setPendingImages([]);
    if (editing) {
      useAgentStore.getState().setEditing(null);
      void sendEditedMessage(text, sent).catch((error: unknown) => {
        useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
        if (!useAgentStore.getState().draft) setDraft(text);
      });
    } else {
      void sendUserMessage(text, sent);
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
          placeholder={blocked ?? (editing ? "Edit your last message…" : "Ask VibeCut…")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={Boolean(blocked) && !busy}
          title={images.length ? `${images.length} image${images.length === 1 ? "" : "s"} will go with it` : undefined}
        />
        {images.length ? <span className="font-mono text-[10px] text-cool-grey">+{images.length}</span> : null}
        {busy ? (
          <button type="button" className={iconButton} onClick={() => void stopTurn()} disabled={status === "stopping"} aria-label="Stop" title="Stop">
            <Square size={14} aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className={iconButton} disabled={!canSend} aria-label="Send" title="Send (Return)">
            <SendHorizontal size={14} aria-hidden="true" />
          </button>
        )}
      </form>
    </div>
  );
}
