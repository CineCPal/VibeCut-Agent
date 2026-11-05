import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Press } from "./Press";

/**
 * A reply, formatted as in the app's window (src/components/chat/Markdown.tsx): Markdown with GFM tables,
 * raw HTML left as text, and timecodes as links that move the editor's playhead. Other links show as
 * text with their address, since a panel can't open a browser.
 */

/** A time in a reply ("1:05", "0:01:05", "01:00:05:12"), which moves the editor's playhead. */
export const TIMECODE = /\b\d{1,2}:\d{2}(?::\d{2}(?:[:;]\d{2})?)?\b/g;

/** A timecode's seconds; frames are dropped (the playhead lands on the second). */
export function timecodeSeconds(code: string): number {
  const [a, b, c] = code.split(/[:;]/).map(Number);
  return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Splits each text node's timecodes out as `t:<seconds>` links (never inside code or a link). */
function splitText(node: MdNode): MdNode[] {
  const text = node.value ?? "";
  const out: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TIMECODE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    out.push({ type: "link", url: `t:${timecodeSeconds(match[0])}`, children: [{ type: "text", value: match[0] }] });
    last = at + match[0].length;
  }
  if (!out.length) return [node];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function remarkTimecodes() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
    node.children = node.children.flatMap((child) => (child.type === "text" ? splitText(child) : (walk(child), [child])));
  };
  return (tree: MdNode) => walk(tree);
}

export function Markdown({ text, seek }: { text: string; seek: ((seconds: number) => void) | null }) {
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith("t:")) {
        const seconds = Number(href.slice(2));
        const label = String(Array.isArray(children) ? children.join("") : children);
        return seek && Number.isFinite(seconds) ? (
          <Press className="vc-link vc-mono" onClick={() => seek(seconds)} aria-label={`Go to ${label}`}>
            {children}
          </Press>
        ) : (
          <span className="vc-mono">{children}</span>
        );
      }
      return (
        <span className="vc-md-link" title={href}>
          {children}
        </span>
      );
    },
  };
  return (
    <div className="vc-md">
      {/* `t:` is the timecodes' own scheme; every other address goes through react-markdown's safe check. */}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkTimecodes]} skipHtml components={components} urlTransform={(url) => (url.startsWith("t:") ? url : defaultUrlTransform(url))}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
