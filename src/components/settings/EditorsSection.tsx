import { useEffect, useState } from "react";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import {
  getPremierePanelStatus,
  installPremierePanel,
  nleReconnect,
  uninstallPremierePanel,
} from "../../lib/ipc";
import { CONNECTION_TEXT, CONNECTION_TONE, connectionDetail, panelAdvice } from "../../lib/nleStatus";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost, PremierePanelStatus } from "../../types/nle";
import { NLE_HOSTS, NLE_LABELS } from "../../types/nle";
import { Section } from "../common/Section";
import { StatusRow } from "../common/StatusRow";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Settings > Editors: each editor's connection with Reconnect, and the Premiere panel's install. */
export function EditorsSection() {
  const hosts = useNleStateStore((s) => s.hosts);
  const [panel, setPanel] = useState<PremierePanelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPremierePanelStatus()
      .then((status) => active && setPanel(status))
      .catch((e: unknown) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, []);

  const run = (action: () => Promise<PremierePanelStatus | void>) => {
    setBusy(true);
    setError(null);
    action()
      .then((status) => {
        if (status) setPanel(status);
      })
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  const reconnect = (host: NleHost) => run(() => nleReconnect(host));
  const advice = panel ? panelAdvice(panel) : null;
  const panelCurrent = panel?.installedVersion && panel.installedVersion === panel.bundledVersion;

  return (
    <Section title="Editors">
      <ul className="divide-y divide-border">
        {NLE_HOSTS.map((host) => {
          const state = hosts[host];
          return (
            <li key={host} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ul>
                  <StatusRow
                    label={NLE_LABELS[host]}
                    tone={CONNECTION_TONE[state.status]}
                    value={CONNECTION_TEXT[state.status]}
                    detail={connectionDetail(state) ?? undefined}
                  />
                </ul>
              </div>
              <button
                type="button"
                className={linkButton}
                disabled={busy || state.status === "unavailable"}
                onClick={() => reconnect(host)}
                aria-label={`Reconnect ${NLE_LABELS[host]}`}
              >
                <RotateCcw size={12} aria-hidden="true" />
                Reconnect
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 rounded-md border border-border bg-canvas px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-white">Premiere panel</span>
          <span className="font-mono text-[11px] text-cool-grey">
            {panel ? (panel.installedVersion ? `v${panel.installedVersion}` : "not installed") : "…"}
          </span>
        </div>
        {advice ? <p className="mt-1 text-[11px] text-warm-grey">{advice}</p> : null}
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            className={linkButton}
            disabled={busy || !panel || Boolean(panelCurrent)}
            onClick={() => run(installPremierePanel)}
          >
            <Download size={12} aria-hidden="true" />
            {panel?.installedVersion ? "Update panel" : "Install panel"}
          </button>
          {panel?.installedVersion ? (
            <button type="button" className={linkButton} disabled={busy} onClick={() => run(uninstallPremierePanel)}>
              <Trash2 size={12} aria-hidden="true" />
              Uninstall
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
