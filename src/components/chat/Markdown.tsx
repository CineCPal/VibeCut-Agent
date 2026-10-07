/**
 * A finished reply, formatted (Phase 8e): Markdown with GFM tables, raw HTML left as text, links opened
 * in the browser, and timeline positions (`t:` links and SMPTE timecodes) as chips that move the playhead.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Play } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { nleCall, openExternal } from "../../lib/ipc";
import { describeError } from "../../lib/agent/context";
import { SMPTE_PATTERN, positionLabel, secondsFromLink, timecodeToSeconds, type TimelineInfo } from "../../lib/agent/timecode";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";

/** The parts of an mdast node this file reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const timeLink = (seconds: number, child: MdNode): MdNode => ({ type: "link", url: `t:${Number(seconds.toFixed(3))}`, children: [child] });

/** A text node with its SMPTE timecodes split out as `t:` links. */
function splitTimecodes(text: string, info: TimelineInfo): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(SMPTE_PATTERN.source, "g"))) {
    const seconds = timecodeToSeconds(match[0], info);
    if (seconds === null) continue;
    if (match.index > last) out.push({ type: "text", value: text.slice(last, match.index) });
    out.push(timeLink(seconds, { type: "text", value: match[0] }));
    last = match.index + match[0].length;
  }
  if (!out.length) return [{ type: "text", value: text }];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function linkTimecodes(node: MdNode, info: TimelineInfo): void {
  if (!node.children) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      out.push(...splitTimecodes(child.value, info));
    } else if (child.type === "inlineCode" && child.value) {
      // Only a timecode on its own: `01:00:12:10`, not code that happens to hold one.
      const seconds = new RegExp(`^${SMPTE_PATTERN.source}$`).test(child.value) ? timecodeToSeconds(child.value, info) : null;
      out.push(seconds === null ? child : timeLink(seconds, child));
    } else {
      // Links and fenced code keep their text as written.
      if (child.type !== "link" && child.type !== "linkReference" && child.type !== "code") linkTimecodes(child, info);
      out.push(child);
    }
  }
  node.children = out;
}

/** A remark plugin: SMPTE timecodes become `t:` links, placed on `info`'s timeline (none without it). */
export function remarkTimecodes(info: TimelineInfo | null) {
  return () => (tree: MdNode) => {
    if (info && info.fps > 0) linkTimecodes(tree, info);
  };
}

/** Only web links and timeline positions survive; anything else (javascript:, file:, …) renders as text. */
export function safeUrl(url: string): string {
  if (secondsFromLink(url) !== null) return url;
  return /^https?:\/\//i.test(url) ? url : "";
}

/** A timeline position in a reply: pressed, it moves the playhead in the editor's open timeline. */
export function TimecodeChip({ seconds, children }: { seconds: number; children: ReactNode }) {
  const host = useNleStateStore(selectActiveHost);
  const timeline = useNleStateStore((s) => (host ? s.hosts[host].timeline : null));
  const [outcome, setOutcome] = useState<{ ok: boolean; detail: string } | null>(null);
  const label = positionLabel(seconds);
  const blocked = !host
    ? "Connect Premiere Pro or DaVinci Resolve to jump to this point"
    : !timeline
      ? "No timeline is open in the editor"
      : null;

  const jump = async () => {
    if (!host || !timeline) return;
    try {
      await nleCall(host, "set_playhead", { timeline, time: seconds });
      setOutcome({ ok: true, detail: `Playhead at ${label}` });
    } catch (error) {
      setOutcome({ ok: false, detail: `Couldn't move the playhead: ${describeError(error)}` });
    }
    setTimeout(() => setOutcome(null), 2000);
  };

  return (
    <button
      type="button"
      onClick={() => void jump()}
      disabled={Boolean(blocked)}
      aria-label={`Move the playhead to ${label}`}
      title={outcome?.detail ?? blocked ?? `Move the playhead in "${timeline}" to ${label}`}
      className={`mx-0.5 inline-flex items-baseline gap-1 rounded border px-1 font-mono text-[12px] leading-snug focus-visible:outline focus-visible:outline-athletic-blue-light disabled:cursor-not-allowed disabled:opacity-60 ${
        outcome && !outcome.ok ? "border-loss text-loss" : "border-athletic-blue-light/50 text-athletic-blue-light hover:bg-athletic-blue/60"
      }`}
    >
      <Play size={9} aria-hidden="true" className="self-center" />
      {children}
    </button>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative my-1.5">
      <pre ref={ref} className="overflow-x-auto rounded-md border border-border bg-canvas p-2 font-mono text-[12px] [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
      <div className="absolute right-1 top-1 opacity-0 focus-within:opacity-100 group-hover/code:opacity-100">
        <CopyButton text={() => ref.current?.textContent ?? ""} label="Copy code" />
      </div>
    </div>
  );
}

const HEADING = "mb-1 mt-2 text-[13px] font-semibold first:mt-0";

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className={HEADING}>{children}</h3>,
  h2: ({ children }) => <h3 className={HEADING}>{children}</h3>,
  h3: ({ children }) => <h4 className={HEADING}>{children}</h4>,
  h4: ({ children }) => <h4 className={HEADING}>{children}</h4>,
  h5: ({ children }) => <h4 className={HEADING}>{children}</h4>,
  h6: ({ children }) => <h4 className={HEADING}>{children}</h4>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-1 list-decimal pl-5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-border pl-2 text-cool-grey">{children}</blockquote>,
  hr: () => <hr className="my-2 border-border" />,
  code: ({ children, className }) => <code className={`rounded bg-canvas px-1 font-mono text-[12px] ${className ?? ""}`}>{children}</code>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border border-border bg-canvas px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-border px-2 py-1 align-top">
      {children}
    </td>
  ),
  // A picture would load from the web; the CSP blocks it anyway, so its description stands in.
  img: ({ alt }) => (alt ? <span className="text-cool-grey">[{alt}]</span> : null),
  a: ({ href, children }) => {
    const seconds = secondsFromLink(href);
    if (seconds !== null) return <TimecodeChip seconds={seconds}>{children}</TimecodeChip>;
    if (!href) return <span>{children}</span>;
    return (
      <a
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          void openExternal(href).catch(() => undefined);
        }}
        className="text-athletic-blue-light underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
};

/** A finished assistant reply. Raw HTML in it shows as text (react-markdown's default). */
export function Markdown({ text }: { text: string }) {
  const info = useNleStateStore((s) => s.lastTimeline);
  const plugins = useMemo(() => [remarkGfm, remarkTimecodes(info)], [info]);
  return (
    <div className="break-words">
      <ReactMarkdown remarkPlugins={plugins} urlTransform={safeUrl} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
