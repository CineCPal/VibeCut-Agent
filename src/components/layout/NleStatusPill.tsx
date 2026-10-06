import { CONNECTION_TEXT, CONNECTION_TONE, connectionDetail } from "../../lib/nleStatus";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import { NLE_HOSTS, NLE_LABELS } from "../../types/nle";
import { StatusDot } from "../common/StatusDot";

const SHORT_LABEL: Record<NleHost, string> = { premiere: "Pr", resolve: "Re" };

export function NleStatusPill() {
  const hosts = useNleStateStore((s) => s.hosts);
  return (
    <ul className="flex items-center gap-1.5" aria-label="Editor connections">
      {NLE_HOSTS.map((host) => {
        const state = hosts[host];
        const detail = connectionDetail(state);
        const description = `${NLE_LABELS[host]}: ${CONNECTION_TEXT[state.status]}${detail ? ` (${detail})` : ""}`;
        return (
          <li
            key={host}
            title={description}
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"
          >
            <StatusDot tone={CONNECTION_TONE[state.status]} />
            <span aria-hidden="true">{SHORT_LABEL[host]}</span>
            <span className="sr-only">{description}</span>
          </li>
        );
      })}
    </ul>
  );
}
