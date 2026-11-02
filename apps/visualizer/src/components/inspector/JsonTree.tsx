/** A collapsible, colour-coded JSON tree (keys, strings, numbers, booleans, null). */
import { useState } from "react";

const MAX_STRING = 400;

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-cool-grey">null</span>;
  if (typeof value === "string") {
    const text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    return <span className="break-all text-profit">"{text}"</span>;
  }
  if (typeof value === "number") return <span className="text-athletic-blue-light">{value}</span>;
  if (typeof value === "boolean") return <span className="text-warning">{String(value)}</span>;
  return <span className="text-cool-grey">{String(value)}</span>;
}

export function JsonTree({ value, label, depth = 0 }: { value: unknown; label?: string; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isArray = Array.isArray(value);
  if (value === null || typeof value !== "object") {
    return (
      <div className="pl-3">
        {label !== undefined && <span className="text-warm-grey">{label}: </span>}
        <Leaf value={value} />
      </div>
    );
  }
  const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <div className="pl-3">
      <button
        type="button"
        className="text-left text-warm-grey hover:text-[#e6edf3]"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} {label !== undefined ? `${label}: ` : ""}
        <span className="text-cool-grey">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open && entries.map(([k, v]) => <JsonTree key={k} label={k} value={v} depth={depth + 1} />)}
    </div>
  );
}
