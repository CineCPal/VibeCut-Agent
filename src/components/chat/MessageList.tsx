import { useEffect, useRef } from "react";
import { AlertTriangle, Wrench } from "lucide-react";
import type { ChatMessage } from "../../types/agent";

const ROLE_LABEL: Record<"user" | "assistant" | "system", string> = { user: "You", assistant: "Agent", system: "System" };

function bubbleClass(message: ChatMessage): string {
  if (message.role === "user") return "ml-8 border-athletic-blue bg-athletic-blue text-white";
  if (message.role === "system") return "border-border bg-transparent text-cool-grey italic";
  return "mr-8 border-border bg-surface text-white";
}

function Row({ message }: { message: ChatMessage }) {
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
  return (
    <article className={`rounded-lg border px-3 py-2 text-sm ${bubbleClass(message)}`}>
      <header className="mb-0.5 text-[11px] text-warm-grey">{ROLE_LABEL[message.role]}</header>
      <p className="whitespace-pre-wrap break-words">{message.text}</p>
    </article>
  );
}

export function MessageList({ messages, activity }: { messages: ChatMessage[]; activity: string | null }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, activity]);

  return (
    <div role="log" aria-live="polite" aria-label="Conversation" className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
      {messages.map((message) => (
        <Row key={message.id} message={message} />
      ))}
      {activity ? (
        <p className="flex items-center gap-2 px-1 text-[11px] text-athletic-blue-light">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-athletic-blue-light" aria-hidden="true" />
          {activity}
        </p>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
