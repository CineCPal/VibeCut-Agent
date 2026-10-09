/** An image filed beside the chat (a message's, Phase 8g, or a tool's frames, Phase 13b), read back to show. */
import { useEffect, useState } from "react";
import { attachmentUrl } from "../../lib/agent/attachments";
import type { ChatAttachment } from "../../types/agent";

/** One image, read back from beside the chat. `size` sets its largest box (a message's by default). */
export function SentImage({ chatId, attachment, size = "max-h-32 max-w-[12rem]" }: { chatId: string; attachment: ChatAttachment; size?: string }) {
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
    <img src={url} alt={attachment.name} title={label} className={`${size} rounded border border-white/30 object-contain`} />
  ) : (
    <span aria-label={`Loading ${attachment.name}`} className="block h-16 w-16 animate-pulse rounded bg-white/10" />
  );
}
