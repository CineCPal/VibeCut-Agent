/**
 * A turn's tool calls as cards (Phase 8f): open while the turn runs, folded to one line after it.
 * Each card opens to show the call's arguments and result.
 */
import { useId, useState } from "react";
import { AlertTriangle, Ban, Check, ChevronRight, Clock, Loader2, Wrench } from "lucide-react";
import { answerReview } from "../../lib/agent/review";
import { CopyButton } from "./CopyButton";
import { SentImage } from "./ChatImage";
import { useAgentStore } from "../../store/useAgentStore";
import type { ChatMessage, ChatToolCall } from "../../types/agent";

function StateIcon({ state }: { state: ChatToolCall["state"] }) {
  if (state === "running") return <Loader2 size={11} className="shrink-0 animate-spin text-athletic-blue-light" aria-label="Running" />;
  if (state === "failed") return <AlertTriangle size={11} className="shrink-0 text-loss" aria-label="Failed" />;
  if (state === "pending") return <Clock size={11} className="shrink-0 text-warning" aria-label="Waiting for you" />;
  if (state === "declined") return <Ban size={11} className="shrink-0 text-cool-grey" aria-label="Skipped" />;
  return <Check size={11} className="shrink-0 text-profit" aria-label="Done" />;
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-cool-grey">
        {label}
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-canvas p-1.5 font-mono text-[11px] text-warm-grey">{text}</pre>
    </div>
  );
}

/** The frames a tool showed the model (Phase 13b), so the user sees what it saw. */
function ToolImages({ message }: { message: ChatMessage }) {
  const chatId = useAgentStore((s) => s.chatId);
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-2 py-1.5" aria-label={`What ${message.tool?.name ?? "the tool"} showed the agent`}>
      {(message.attachments ?? []).map((a) => (
        <SentImage key={a.id} chatId={chatId} attachment={a} size="max-h-48 max-w-full" />
      ))}
    </div>
  );
}

function ToolCard({ message }: { message: ChatMessage & { tool: ChatToolCall } }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { tool } = message;
  return (
    <li className="rounded border border-border/70 bg-canvas/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-1.5 px-1.5 py-1 text-left text-[11px] focus-visible:outline focus-visible:outline-athletic-blue-light"
      >
        <ChevronRight size={11} aria-hidden="true" className={`mt-0.5 shrink-0 text-cool-grey transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="mt-0.5">
          <StateIcon state={tool.state} />
        </span>
        <span className="min-w-0">
          <span className="font-mono text-athletic-blue-light">{tool.name}</span>
          {message.text !== tool.name ? (
            <span className={`ml-1.5 break-words ${tool.state === "failed" ? "text-loss" : tool.state === "pending" ? "text-white" : "text-cool-grey"}`}>
              {tool.state === "declined" ? `Skipped: ${message.text}` : message.text}
            </span>
          ) : null}
        </span>
      </button>
      {message.attachments?.length ? <ToolImages message={message} /> : null}
      {tool.state === "pending" ? (
        // Review edits first (Phase 11d): the change waits here for the user.
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-2 py-1.5" role="group" aria-label={`Review ${tool.name}`}>
          <button type="button" onClick={() => answerReview(message.id, "apply")} className="rounded bg-athletic-blue px-2 py-0.5 text-[11px] text-white hover:bg-athletic-blue/80">
            Apply
          </button>
          <button type="button" onClick={() => answerReview(message.id, "skip")} className="rounded border border-border px-2 py-0.5 text-[11px] text-warm-grey hover:text-white">
            Skip
          </button>
          <button
            type="button"
            onClick={() => answerReview(message.id, "all")}
            title="Apply this and the rest of this request's changes without asking"
            className="rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white"
          >
            Apply all for this request
          </button>
        </div>
      ) : null}
      {open ? (
        <div id={detailsId} className="flex flex-col gap-1 border-t border-border/70 px-2 py-1.5">
          <Detail label="Arguments" text={tool.args} />
          {tool.result !== undefined ? <Detail label="Result" text={tool.result} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Consecutive tool calls. `live`: the turn they belong to is still running, so they stay open. */
export function ToolGroup({ messages, live }: { messages: (ChatMessage & { tool: ChatToolCall })[]; live: boolean }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const listId = useId();
  const running = messages.some((m) => m.tool.state === "running" || m.tool.state === "pending");
  const open = chosen ?? (live || running);
  const failed = messages.filter((m) => m.tool.state === "failed").length;
  return (
    <section aria-label="Tool calls" className="px-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChosen(!open)}
        className="flex items-center gap-1.5 rounded px-0.5 text-[11px] text-cool-grey hover:text-athletic-blue-light focus-visible:text-athletic-blue-light"
      >
        <ChevronRight size={11} aria-hidden="true" className={`transition-transform ${open ? "rotate-90" : ""}`} />
        <Wrench size={11} aria-hidden="true" />
        {`${messages.length} tool call${messages.length === 1 ? "" : "s"} `}
        {failed ? <span className="text-loss">{`· ${failed} failed`}</span> : null}
        {running ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <ul id={listId} className="mt-1 flex flex-col gap-1">
          {messages.map((m) => (
            <ToolCard key={m.id} message={m} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
