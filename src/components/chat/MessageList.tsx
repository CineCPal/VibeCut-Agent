import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Pencil, RotateCcw, Wrench } from "lucide-react";
import { ACTION_BUTTON, CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./ToolCards";
import type { ChatAttachment, ChatMessage, ChatToolCall } from "../../types/agent";
import { attachmentUrl } from "../../lib/agent/attachments";
import { useAgentStore } from "../../store/useAgentStore";

const ROLE_LABEL: Record<"user" | "assistant" | "system", string> = { user: "You", assistant: "Agent", system: "System" };
/** Within this distance of the bottom, the list follows new text; scrolled further up, it stays put. */
const PINNED_PX = 48;

function bubbleClass(message: ChatMessage): string {
  if (message.role === "user") return "ml-8 border-athletic-blue bg-athletic-blue text-white";
  if (message.role === "system") return "border-border bg-transparent text-cool-grey italic";
  return "mr-8 border-border bg-surface text-white";
}

/** What can be done with the last turn (Phase 8c): Retry and Edit, and why not when they can't. */
export interface TurnActions {
  userMessageId: string;
  /** Why Retry/Edit can't run now, or null. */
  blocked: string | null;
  /** Its timeline edits not reverted yet: Retry and Edit revert them first. */
  edits: number;
  onRetry: () => void;
  onEdit: () => void;
}

/** One image sent with a message (Phase 8g), read back from beside the chat. */
function SentImage({ chatId, attachment }: { chatId: string; attachment: ChatAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(chatId, attachment)
      .then((u) => live && setUrl(u))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [chatId, attachment]);
  const label = `${attachment.name} · ${attachment.width}×${attachment.height}`;
  if (missing) {
    return <span className="flex h-16 items-center rounded border border-white/30 px-2 text-[11px] text-white/70">{attachment.name} (no longer on disk)</span>;
  }
  return url ? (
    <img src={url} alt={attachment.name} title={label} className="max-h-32 max-w-[12rem] rounded border border-white/30 object-contain" />
  ) : (
    <span aria-label={`Loading ${attachment.name}`} className="block h-16 w-16 animate-pulse rounded bg-white/10" />
  );
}

function SentImages({ attachments }: { attachments: ChatAttachment[] }) {
  const chatId = useAgentStore((s) => s.chatId);
  return (
    <div className="mb-1 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <SentImage key={a.id} chatId={chatId} attachment={a} />
      ))}
    </div>
  );
}

/** A reply still being written (Phase 8b). Its text grows outside the accessibility tree, so a screen
 * reader hears "replying" once and then the finished message, which renders as a new node. */
function StreamingReply({ message }: { message: ChatMessage }) {
  return (
    <article aria-busy="true" className={`rounded-lg border px-3 py-2 text-sm ${bubbleClass(message)}`}>
      <header className="mb-0.5 text-[11px] text-warm-grey">{ROLE_LABEL.assistant}</header>
      <span className="sr-only">Agent is replying…</span>
      <p aria-hidden="true" className="whitespace-pre-wrap break-words">
        {message.text}
        <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-athletic-blue-light" />
      </p>
    </article>
  );
}

function Row({ message, onEdit, editBlocked }: { message: ChatMessage; onEdit?: () => void; editBlocked?: string | null }) {
  if (message.role === "tool") {
    return (
      <p className="flex items-start gap-1.5 px-1 font-mono text-[11px] text-cool-grey">
        <Wrench size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="break-words">{message.text}</span>
      </p>
    );
  }
  if (message.role === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 rounded-md border border-loss/50 bg-loss/10 px-2.5 py-1.5 text-xs text-white">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-loss" aria-hidden="true" />
        <span className="whitespace-pre-wrap break-words">{message.text}</span>
      </p>
    );
  }
  if (message.role === "assistant" && message.status === "pending") return <StreamingReply message={message} />;
  const actions = message.role !== "system";
  return (
    <article className={`group relative rounded-lg border px-3 py-2 text-sm ${bubbleClass(message)}`}>
      <header className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-warm-grey">
        {ROLE_LABEL[message.role]}
        {actions ? (
          // Shown on hover, and whenever one of them has focus, so the keyboard reaches them too.
          <span className="-my-0.5 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {onEdit ? (
              <button
                type="button"
                onClick={onEdit}
                disabled={Boolean(editBlocked)}
                aria-label="Edit your last message"
                title={editBlocked ?? "Edit and send again (↑ in an empty message box)"}
                className={ACTION_BUTTON}
              >
                <Pencil size={11} aria-hidden="true" />
              </button>
            ) : null}
            <CopyButton text={message.text} />
          </span>
        ) : null}
      </header>
      {message.attachments?.length ? <SentImages attachments={message.attachments} /> : null}
      {message.role === "assistant" ? <Markdown text={message.text} /> : <p className="whitespace-pre-wrap break-words">{message.text}</p>}
    </article>
  );
}

function RetryRow({ turn }: { turn: TurnActions }) {
  const label = turn.edits ? `Revert ${turn.edits} edit${turn.edits === 1 ? "" : "s"} & retry` : "Retry";
  return (
    <div className="flex justify-end px-1">
      <button
        type="button"
        onClick={turn.onRetry}
        disabled={Boolean(turn.blocked)}
        title={
          turn.blocked ??
          (turn.edits ? "Undo the edits this request made, then send it again" : "Send the last message again, from where it started")
        }
        className={ACTION_BUTTON}
      >
        <RotateCcw size={11} aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}

type ToolMessage = ChatMessage & { tool: ChatToolCall };
type Item = { kind: "message"; message: ChatMessage } | { kind: "tools"; messages: ToolMessage[] };

/** The list as it's shown: consecutive tool calls (Phase 8f) gathered into one group. */
function itemsOf(messages: ChatMessage[]): Item[] {
  const items: Item[] = [];
  for (const message of messages) {
    const last = items[items.length - 1];
    if (message.role === "tool" && message.tool) {
      if (last?.kind === "tools") last.messages.push(message as ToolMessage);
      else items.push({ kind: "tools", messages: [message as ToolMessage] });
    } else {
      items.push({ kind: "message", message });
    }
  }
  return items;
}

export function MessageList({
  messages,
  activity,
  turn,
  busy = false,
}: {
  messages: ChatMessage[];
  activity: string | null;
  turn?: TurnActions | null;
  /** A turn is running: the newest tool calls stay open. */
  busy?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const streaming = messages.some((m) => m.role === "assistant" && m.status === "pending");
  const last = messages[messages.length - 1];
  const items = itemsOf(messages);

  const onScroll = () => {
    const list = listRef.current;
    if (list) pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight <= PINNED_PX;
  };

  // A new message always comes into view.
  useEffect(() => {
    pinned.current = true;
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  // Growing text (a streamed reply) and the activity line follow only while the list is at the bottom.
  useLayoutEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [last?.text, activity]);

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Conversation"
      className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
    >
      {items.map((item, index) =>
        item.kind === "tools" ? (
          <ToolGroup key={item.messages[0].id} messages={item.messages} live={busy && index >= items.length - 2} />
        ) : (
          // A finished reply gets a new key, so it's announced as a new message.
          <Row
            key={item.message.status === "pending" ? `${item.message.id}:live` : item.message.id}
            message={item.message}
            onEdit={turn && item.message.id === turn.userMessageId ? turn.onEdit : undefined}
            editBlocked={turn?.blocked}
          />
        ),
      )}
      {turn && !streaming && !activity ? <RetryRow turn={turn} /> : null}
      {activity && !streaming ? (
        <p className="flex items-center gap-2 px-1 text-[11px] text-athletic-blue-light">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-athletic-blue-light" aria-hidden="true" />
          {activity}
        </p>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
