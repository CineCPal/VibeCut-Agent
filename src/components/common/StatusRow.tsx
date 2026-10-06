import type { ReactNode } from "react";
import { StatusDot, type Tone } from "./StatusDot";

interface StatusRowProps {
  label: string;
  tone: Tone;
  value: string;
  detail?: ReactNode;
}

export function StatusRow({ label, tone, value, detail }: StatusRowProps) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-white">{label}</span>
        <span className="flex items-center gap-1.5 text-xs">
          <StatusDot tone={tone} />
          {value}
        </span>
      </div>
      {detail ? <div className="truncate font-mono text-[11px] text-cool-grey">{detail}</div> : null}
    </li>
  );
}
