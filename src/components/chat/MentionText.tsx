import type { ReactNode } from "react";
import type { ChatMention } from "../../types/agent";

const KIND_TITLE: Record<ChatMention["kind"], string> = {
  timeline: "Timeline",
  clip: "Clip",
  marker: "Marker",
  media: "Media",
  speaker: "Speaker",
  shot: "Library shot",
};

/** A user message's text with each @-mention (Phase 11c) shown as a chip naming what it points at. */
export function MentionText({ text, mentions }: { text: string; mentions?: ChatMention[] }) {
  if (!mentions?.length) return <>{text}</>;
  // Longest labels first, so "@Interview A long" isn't cut at "@Interview A".
  const sorted = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    let best: { at: number; mention: ChatMention } | null = null;
    for (const mention of sorted) {
      const at = rest.indexOf(`@${mention.label}`);
      if (at >= 0 && (!best || at < best.at)) best = { at, mention };
    }
    if (!best) {
      parts.push(rest);
      break;
    }
    if (best.at) parts.push(rest.slice(0, best.at));
    const { mention } = best;
    parts.push(
      <span
        key={key++}
        title={`${KIND_TITLE[mention.kind]}: ${mention.ref}${mention.detail ? ` · ${mention.detail}` : ""}`}
        className="rounded bg-white/15 px-1 font-medium"
      >
        @{mention.label}
      </span>,
    );
    rest = rest.slice(best.at + mention.label.length + 1);
  }
  return <>{parts}</>;
}
