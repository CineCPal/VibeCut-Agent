import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Pencil, RotateCcw, Wrench } from "lucide-react";
import type { ChatMessage } from "../../types/agent";

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

const ACTION_BUTTON =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-cool-grey hover:text-athletic-blue-light focus-visible:text-athletic-blue-light disabled:opacity-40";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timer = setTimeout(() => (setCopied(false), setFailed(false)), 1500);
    return () => clearTimeout(timer);
  }, [copied, failed]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy message"} title="Copy" className={ACTION_BUTTON}>
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      {copied ? "Copied" : failed ? "Couldn't copy" : null}
    </button>
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
      <p className="whitespace-pre-wrap break-words">{message.text}</p>
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

export function MessageList({ messages, activity, turn }: { messages: ChatMessage[]; activity: string | null; turn?: TurnActions | null }) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const streaming = messages.some((m) => m.role === "assistant" && m.status === "pending");
  const last = messages[messages.length - 1];

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
      {messages.map((message) => (
        // A finished reply gets a new key, so it's announced as a new message.
        <Row
          key={message.status === "pending" ? `${message.id}:live` : message.id}
          message={message}
          onEdit={turn && message.id === turn.userMessageId ? turn.onEdit : undefined}
          editBlocked={turn?.blocked}
        />
      ))}
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
