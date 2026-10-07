import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export const ACTION_BUTTON =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-cool-grey hover:text-athletic-blue-light focus-visible:text-athletic-blue-light disabled:opacity-40";

/** Copies `text` (or what it returns when pressed), saying "Copied" for 1.5 s. */
export function CopyButton({ text, label = "Copy message" }: { text: string | (() => string); label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timer = setTimeout(() => (setCopied(false), setFailed(false)), 1500);
    return () => clearTimeout(timer);
  }, [copied, failed]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={copied ? "Copied" : label} title="Copy" className={ACTION_BUTTON}>
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      {copied ? "Copied" : failed ? "Couldn't copy" : null}
    </button>
  );
}
