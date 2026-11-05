import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ClaudeFamily, EffortLevel, GeminiEffort } from "../src/types/agent";
import type { HostPanelMessage, HostPanelStateFile, HostPanelToolCall } from "../src/types/hostPanel";
import { Markdown, TIMECODE, timecodeSeconds } from "./Markdown";
import { Check, Press } from "./Press";
import type { HostPanelView } from "./useHostPanel";

/**
 * The Chat tab of the "VibeCut Agent" panel in Premiere and Resolve (`vibecut.host.panels.v1`), after
 * VibeCut's src-host-panel App.tsx: the app's own conversation, with the open draft, Review edits first's
 * cards, Retry, Edit, Revert, the queue, and the composer with the model, effort and saved prompts. As in
 * the window (0.20.0): formatted replies, Copy on each message, and tool cards that open to their
 * arguments and result. The app does the work; this shows `state.json` and writes actions.
 */

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const GEMINI_EFFORTS: readonly GeminiEffort[] = ["low", "medium", "high"];

/** Copies `text` with the panel's pasteboard; says so for a moment. */
function CopyButton({ text, label, copy }: { text: string; label: string; copy?: (text: string) => void }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  if (!copy || !text) return null;
  return (
    <Press
      className="vc-link vc-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        copy(text);
        setDone(true);
      }}
    >
      {done ? "Copied" : "Copy"}
    </Press>
  );
}

const STATE_MARK: Record<HostPanelToolCall["state"], { mark: string; label: string; className: string }> = {
  running: { mark: "…", label: "Running", className: "vc-tool-running" },
  done: { mark: "✓", label: "Done", className: "vc-tool-done" },
  failed: { mark: "!", label: "Failed", className: "vc-tool-failed" },
  pending: { mark: "◷", label: "Waiting for you", className: "vc-tool-pending" },
  declined: { mark: "⊘", label: "Skipped", className: "vc-tool-declined" },
};

/** A tool call as the window's card: its state, name and summary, opening to its arguments and result. */
function ToolCard({ message, copy }: { message: HostPanelMessage; copy?: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const tool = message.tool!;
  const state = STATE_MARK[tool.state];
  return (
    <div className={`vc-tool ${state.className}`}>
      <Press className="vc-tool-head" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Fold the call" : "Show the call's arguments and result"}>
        <span className="vc-tool-mark" aria-label={state.label}>
          {state.mark}
        </span>
        <span className="vc-mono vc-tool-name">{tool.name}</span>
        <span className="vc-grow vc-truncate vc-muted">{message.text}</span>
      </Press>
      {open && (
        <div className="vc-tool-body">
          <p className="vc-msg-text">{message.text}</p>
          {[
            ["Arguments", tool.args],
            ["Result", tool.result ?? ""],
          ].map(([label, text]) =>
            text ? (
              <div key={label}>
                <div className="vc-row">
                  <span className="vc-grow vc-faint">{label}</span>
                  <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} copy={copy} />
                </div>
                <pre className="vc-pre">{text}</pre>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

function Button({ children, onClick, disabled, primary, label, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; label?: string; title?: string }) {
  return (
    <Press className={primary ? "vc-btn vc-btn-primary" : "vc-btn"} disabled={disabled} onClick={onClick} aria-label={label} title={title}>
      {children}
    </Press>
  );
}

/** Text with each timecode a link to that point on the timeline. */
function Timed({ text, seek }: { text: string; seek: ((seconds: number) => void) | null }) {
  if (!seek) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(TIMECODE)) {
    const index = match.index ?? 0;
    parts.push(text.slice(at, index));
    const code = match[0];
    parts.push(
      <Press key={`${index}-${code}`} className="vc-link vc-mono" onClick={() => seek(timecodeSeconds(code))} aria-label={`Go to ${code}`}>
        {code}
      </Press>,
    );
    at = index + code.length;
  }
  parts.push(text.slice(at));
  return <>{parts.map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : p))}</>;
}

function Findings({ message, seek }: { message: HostPanelMessage; seek: ((seconds: number) => void) | null }) {
  const findings = message.tool?.findings;
  if (!findings?.length) return null;
  return (
    <ul className="vc-review">
      {findings.map((f, i) => (
        <li key={i} className="vc-row">
          {seek ? (
            <Press className={`vc-link vc-mono vc-sev-${f.severity}`} onClick={() => seek(f.time)} aria-label={`Go to ${clock(f.time)}`}>
              {clock(f.time)}
            </Press>
          ) : (
            <span className={`vc-mono vc-sev-${f.severity}`}>{clock(f.time)}</span>
          )}
          <span className="vc-grow">
            <Timed text={f.text} seek={seek} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A change waiting for Review edits first: Apply, Skip or Apply all. */
function ReviewCard({ message, view }: { message: HostPanelMessage; view: HostPanelView }) {
  const card = message.tool!;
  const decide = (decision: "apply" | "skip" | "all") => view.act({ type: "review_decision", cardId: card.id, decision });
  return (
    <div className="vc-msg vc-msg-tool" role="group" aria-label="Change waiting for review">
      <p className="vc-msg-text">{message.text}</p>
      <div className="vc-row vc-wrap">
        <Button primary onClick={() => decide("apply")}>
          Apply
        </Button>
        <Button onClick={() => decide("skip")}>Skip</Button>
        <Button onClick={() => decide("all")} title="Apply this and the rest of this request's changes without asking">
          Apply all
        </Button>
      </div>
    </div>
  );
}

function Message({ message, seek, turn, copy }: { message: HostPanelMessage; seek: ((seconds: number) => void) | null; turn?: ReactNode; copy?: (text: string) => void }) {
  const role = message.role === "system" ? "tool" : message.role;
  // A finished reply is formatted; one still streaming stays plain text, as in the window.
  const formatted = message.role === "assistant" && message.status !== "pending" && !!message.text;
  return (
    <div className={`vc-msg vc-msg-${role}`}>
      {formatted ? (
        <Markdown text={message.text} seek={seek} />
      ) : (
        <p className="vc-msg-text">
          {message.role === "tool" ? <Timed text={message.text} seek={seek} /> : message.text}
          {message.status === "pending" && !message.text ? "…" : ""}
        </p>
      )}
      {(message.role === "user" || message.role === "assistant") && message.status !== "pending" ? (
        <div className="vc-msg-actions">
          <CopyButton text={message.text} label="Copy message" copy={copy} />
        </div>
      ) : null}
      {message.imageCount ? <p className="vc-faint">{plural(message.imageCount, "image")}</p> : null}
      <Findings message={message} seek={seek} />
      {message.tool?.state === "declined" && <p className="vc-faint">Skipped</p>}
      {turn}
    </div>
  );
}

/** A plain tool step: one line, folded into a run with its neighbours. Review cards and findings stay
 * messages of their own, since they carry buttons. */
const plainStep = (m: HostPanelMessage) => m.role === "tool" && !!m.tool && m.tool.state !== "pending" && !m.tool.findings?.length;
/** Runs this long or longer fold to one line until opened. */
const FOLD_STEPS = 3;

type Item = { kind: "message"; message: HostPanelMessage } | { kind: "steps"; key: string; steps: HostPanelMessage[] };

function grouped(messages: HostPanelMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    const last = items[items.length - 1];
    if (plainStep(m) && last?.kind === "steps") last.steps.push(m);
    else if (plainStep(m)) items.push({ kind: "steps", key: m.id, steps: [m] });
    else items.push({ kind: "message", message: m });
  }
  return items;
}

function Steps({ steps, open, toggle, copy }: { steps: HostPanelMessage[]; open: boolean; toggle: () => void; copy?: (text: string) => void }) {
  const rows = (list: HostPanelMessage[]) => list.map((m) => <ToolCard key={m.id} message={m} copy={copy} />);
  if (steps.length < FOLD_STEPS) return <>{rows(steps)}</>;
  const last = steps[steps.length - 1];
  return (
    <div className="vc-steps">
      <Press className="vc-steps-toggle" aria-expanded={open} onClick={toggle} title={open ? "Fold the steps" : last.text}>
        <span className="vc-steps-count">
          {open ? "▾" : "▸"} {steps.length} steps
        </span>
        {!open && <span className="vc-steps-last vc-truncate">{last.text}</span>}
      </Press>
      {open && rows(steps)}
    </div>
  );
}

function Messages({ state, view, seek, onEdit, copy }: { state: HostPanelStateFile; view: HostPanelView; seek: ((seconds: number) => void) | null; onEdit: () => void; copy?: (text: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const { messages, canRetry, lastTurnEdits, rewindBlocked } = state.chat;
  const last = messages[messages.length - 1];
  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;
  // A block, not an expression: newer Chromium's scrollIntoView returns a Promise, which React would
  // take for the effect's cleanup (VibeCut's 13d).
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, last?.text]);
  if (!messages.length) {
    return (
      <div className="vc-messages">
        <p className="vc-muted vc-empty">
          Ask the agent to work on this {state.host === "premiere" ? "sequence" : "timeline"}: cut, trim or move clips, add markers, captions or B-roll, or build a story cut. Each request's edits can be
          reverted.
        </p>
      </div>
    );
  }
  const turn = canRetry ? (
    <div className="vc-row">
      <Button onClick={() => view.act({ type: "retry" })} title={rewindBlocked ?? "Send this message again"}>
        {lastTurnEdits > 0 ? `Revert ${lastTurnEdits} & retry` : "Retry"}
      </Button>
      <Button onClick={onEdit}>Edit</Button>
    </div>
  ) : undefined;
  return (
    <div className="vc-messages" aria-live="polite">
      {grouped(messages).map((item) =>
        item.kind === "message" ? (
          item.message.tool?.state === "pending" ? (
            <ReviewCard key={item.message.id} message={item.message} view={view} />
          ) : (
            <Message key={item.message.id} message={item.message} seek={seek} copy={copy} turn={item.message.id === lastUserId ? turn : undefined} />
          )
        ) : (
          <Steps
            key={item.key}
            steps={item.steps}
            copy={copy}
            open={opened.has(item.key)}
            toggle={() =>
              setOpened((prev) => {
                const next = new Set(prev);
                if (next.has(item.key)) next.delete(item.key);
                else next.add(item.key);
                return next;
              })
            }
          />
        ),
      )}
      <div ref={end} />
    </div>
  );
}

function Draft({ state, view }: { state: HostPanelStateFile; view: HostPanelView }) {
  const draft = state.openDraft;
  if (!draft) return null;
  const busy = state.agent.status === "thinking" || state.agent.status === "stopping" || !!view.pending;
  return (
    <div className="vc-draft" role="region" aria-label="Draft">
      <div className="vc-row vc-wrap">
        <span className="vc-grow vc-truncate" title={draft.changes.join("\n")}>
          Draft of “{draft.base}”: {plural(draft.changes.length, "change")}, {clock(draft.duration)}
        </span>
        <Button primary disabled={busy} onClick={() => view.act({ type: "draft_send" })} title={`Make a new ${state.host === "premiere" ? "sequence" : "timeline"} from the draft`}>
          Send
        </Button>
        <Button disabled={busy} onClick={() => view.act({ type: "draft_discard" })}>
          Discard
        </Button>
      </div>
    </div>
  );
}

function Queue({ state, view }: { state: HostPanelStateFile; view: HostPanelView }) {
  const { queue, queuePaused } = state.chat;
  if (!queue.length) return null;
  return (
    <div className="vc-log" role="region" aria-label="Queued messages">
      <div className="vc-row">
        <span className="vc-grow vc-faint">
          {plural(queue.length, "message")} waiting{queuePaused ? " (held)" : ""}
        </span>
        {queuePaused && <Button onClick={() => view.act({ type: "queue_resume" })}>Send next</Button>}
        <Button onClick={() => view.act({ type: "queue_clear" })}>Clear</Button>
      </div>
      <ul className="vc-list">
        {queue.map((q) => (
          <li key={q.id} className="vc-row">
            <span className="vc-grow vc-truncate" title={q.text}>
              {q.text || plural(q.imageCount, "image")}
            </span>
            <Press className="vc-link" onClick={() => view.act({ type: "queue_remove", queueId: q.id })} aria-label={`Remove “${q.text}” from the queue`}>
              ✕
            </Press>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelRow({ state, view }: { state: HostPanelStateFile; view: HostPanelView }) {
  const { agent } = state;
  const working = agent.status === "thinking" || agent.status === "stopping";
  const family: ClaudeFamily | null = agent.aiChoice.includes("opus") ? "opus" : agent.aiChoice.includes("sonnet") ? "sonnet" : null;
  return (
    <div className="vc-row vc-models vc-wrap">
      <select className="vc-select" aria-label="Agent model" value={agent.aiChoice} disabled={working} onChange={(e) => view.act({ type: "set_model", aiChoice: e.target.value as typeof agent.aiChoice })}>
        {agent.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {family ? (
        <select className="vc-select" aria-label="Effort" value={agent.effort[family]} disabled={working} onChange={(e) => view.act({ type: "set_effort", family, effort: e.target.value as EffortLevel })}>
          {EFFORTS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      ) : (
        <select className="vc-select" aria-label="Thinking" value={agent.geminiEffort} disabled={working} onChange={(e) => view.act({ type: "set_gemini_effort", effort: e.target.value as GeminiEffort })}>
          {GEMINI_EFFORTS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      <Check className="vc-check" checked={agent.reviewEdits} onChange={(on) => view.act({ type: "set_review_edits", on })} title="Wait for Apply before each change to the timeline or project">
        Review edits
      </Check>
    </div>
  );
}

const PROMPT_QUERY = /^\/([\w-]*)$/;

function Composer({ state, view, text, setText, editing, setEditing }: { state: HostPanelStateFile; view: HostPanelView; text: string; setText: (text: string) => void; editing: boolean; setEditing: (on: boolean) => void }) {
  const { agent } = state;
  const thinking = agent.status === "thinking" || agent.status === "stopping" || agent.outsideRunning;
  const offline = agent.status === "offline" || agent.status === "error";
  const query = PROMPT_QUERY.exec(text);
  const prompts = query ? state.prompts.filter((p) => p.name.startsWith(query[1].toLowerCase())) : [];
  const canSend = !offline && text.trim().length > 0 && !query;
  const lastUser = [...state.chat.messages].reverse().find((m) => m.role === "user");

  const send = () => {
    if (!canSend) return;
    view.act(editing ? { type: "edit_last", text: text.trim() } : { type: "send", text: text.trim() });
    setText("");
    setEditing(false);
  };
  const pick = (body: string) => setText(body);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (prompts.length) pick(prompts[0].body);
      else send();
    } else if (e.key === "ArrowUp" && !text && state.chat.canRetry && lastUser) {
      e.preventDefault();
      setText(lastUser.text);
      setEditing(true);
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      setText("");
      setEditing(false);
    }
  };

  return (
    <div className="vc-composer">
      <ModelRow state={state} view={view} />
      {agent.activity && (
        <p className="vc-working vc-truncate" role="status" title={agent.activity}>
          <span className="vc-dot vc-dot-wait" /> {agent.activity}
        </p>
      )}
      {offline && <p className="vc-faint">{agent.statusDetail ?? "The agent isn't running."}</p>}
      {editing && <p className="vc-faint">Editing your last message: sending replaces it and runs it again. Esc cancels.</p>}
      <textarea
        className="vc-input"
        rows={3}
        value={text}
        placeholder={thinking ? "Queue a message…" : `Ask the agent about this ${state.host === "premiere" ? "sequence" : "timeline"}…`}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {prompts.length > 0 && (
        <ul className="vc-list" role="listbox" aria-label="Saved prompts">
          {prompts.map((p) => (
            <li key={p.id}>
              <Press className="vc-link" onClick={() => pick(p.body)} title={p.body}>
                /{p.name}
              </Press>
            </li>
          ))}
        </ul>
      )}
      <div className="vc-row vc-composer-actions">
        <span className="vc-faint vc-grow vc-truncate">{query ? "Enter picks the first prompt" : "Enter sends · Shift+Enter for a new line · ↑ edits"}</span>
        {thinking && (
          <Press className="vc-btn vc-btn-stop" onClick={() => view.act({ type: "stop" })} disabled={agent.status !== "thinking"} aria-label="Stop the agent">
            ■ Stop
          </Press>
        )}
        <Button primary onClick={send} disabled={!canSend}>
          {editing ? "Send edit" : thinking ? "Queue" : "Send"}
        </Button>
      </div>
    </div>
  );
}

export function ChatTab({ state, view, copy }: { state: HostPanelStateFile; view: HostPanelView; copy?: (text: string) => void }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const { chat, agent, editor } = state;
  const running = agent.status === "thinking" || agent.status === "stopping";
  const seek = editor.connected && editor.timeline ? (seconds: number) => view.act({ type: "set_playhead", seconds }) : null;
  const startEdit = () => {
    const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setText(lastUser.text);
    setEditing(true);
  };
  return (
    <>
      <div className="vc-row vc-pad">
        <span className="vc-grow vc-truncate" title={`${chat.title} · ${editor.timeline ?? "No open timeline"}`}>
          <strong>{chat.messages.length ? chat.title : "New chat"}</strong>
          <span className="vc-faint"> · {editor.timeline ?? "No open timeline"}</span>
        </span>
        {chat.revertable > 0 && (
          <Button
            disabled={running || !!view.pending}
            onClick={() => view.act({ type: "revert" })}
            label={`Revert ${plural(chat.revertable, "edit")}${chat.earlierSessionRevert ? " (earlier session)" : ""}`}
            title="Undo every edit of the latest request that changed the timeline"
          >
            Revert {chat.revertable}
          </Button>
        )}
        {chat.messages.length > 0 && (
          <Button disabled={running} onClick={() => view.act({ type: "new_chat" })}>
            New chat
          </Button>
        )}
      </div>
      <Draft state={state} view={view} />
      <Messages state={state} view={view} seek={seek} onEdit={startEdit} copy={copy} />
      <Queue state={state} view={view} />
      <Composer state={state} view={view} text={text} setText={setText} editing={editing} setEditing={setEditing} />
    </>
  );
}
