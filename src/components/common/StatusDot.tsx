export type Tone = "ok" | "warn" | "bad" | "off";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-profit",
  warn: "bg-warning",
  bad: "bg-loss",
  off: "bg-cool-grey",
};

/** A small status dot. Always pair it with a text label; color alone carries no meaning. */
export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[tone]}`} />;
}
