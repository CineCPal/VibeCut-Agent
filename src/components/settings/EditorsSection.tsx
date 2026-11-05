import { useEffect, useState } from "react";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import {
  getPremierePanelStatus,
  getResolvePluginStatus,
  installPremierePanel,
  installResolvePlugin,
  nleReconnect,
  uninstallPremierePanel,
  uninstallResolvePlugin,
} from "../../lib/ipc";
import { CONNECTION_TEXT, CONNECTION_TONE, panelAdvice, resolvePluginAdvice } from "../../lib/nleStatus";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost, PremierePanelStatus, ResolvePluginStatus } from "../../types/nle";
import { NLE_HOSTS, NLE_LABELS } from "../../types/nle";
import { Section } from "../common/Section";
import { StatusRow } from "../common/StatusRow";

const linkButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-athletic-blue-light hover:text-white disabled:opacity-50";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Installed {
  installedVersion: string | null;
  bundledVersion: string | null;
}

/** One thing the app installs into an editor: its version, what to do next, Install/Update and Uninstall. */
function InstallCard({
  label,
  noun,
  status,
  advice,
  busy,
  onInstall,
  onUninstall,
}: {
  label: string;
  noun: string;
  status: Installed | null;
  advice: string | null;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const current = status?.installedVersion && status.installedVersion === status.bundledVersion;
  return (
    <div className="mt-2 rounded-md border border-border bg-canvas px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-white">{label}</span>
        <span className="font-mono text-[11px] text-cool-grey">
          {status ? (status.installedVersion ? `v${status.installedVersion}` : "not installed") : "…"}
        </span>
      </div>
      {advice ? <p className="mt-1 text-[11px] text-warm-grey">{advice}</p> : null}
      <div className="mt-1.5 flex gap-2">
        <button type="button" className={linkButton} disabled={busy || !status || Boolean(current)} onClick={onInstall}>
          <Download size={12} aria-hidden="true" />
          {status?.installedVersion ? `Update ${noun}` : `Install ${noun}`}
        </button>
        {status?.installedVersion ? (
          <button type="button" className={linkButton} disabled={busy} onClick={onUninstall} aria-label={`Uninstall the ${label}`}>
            <Trash2 size={12} aria-hidden="true" />
            Uninstall
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Settings > Editors: each editor's connection with Reconnect, and the installs of the Premiere panel and
 * the Resolve plugin (the in-editor VibeCut Agent panels). */
export function EditorsSection() {
  const hosts = useNleStateStore((s) => s.hosts);
  const [panel, setPanel] = useState<PremierePanelStatus | null>(null);
  const [plugin, setPlugin] = useState<ResolvePluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPremierePanelStatus()
      .then((status) => active && setPanel(status))
      .catch((e: unknown) => active && setError(message(e)));
    getResolvePluginStatus()
      .then((status) => active && setPlugin(status))
      .catch((e: unknown) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, []);

  const run = <T,>(action: () => Promise<T>, apply?: (status: T) => void) => {
    setBusy(true);
    setError(null);
    action()
      .then((status) => apply?.(status))
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  const reconnect = (host: NleHost) => run(() => nleReconnect(host));

  return (
    <Section title="Connections">
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

      <InstallCard
        label="Premiere panel"
        noun="panel"
        status={panel}
        advice={panel ? panelAdvice(panel) : null}
        busy={busy}
        onInstall={() => run(installPremierePanel, setPanel)}
        onUninstall={() => run(uninstallPremierePanel, setPanel)}
      />
      <InstallCard
        label="DaVinci Resolve plugin"
        noun="plugin"
        status={plugin}
        advice={plugin ? resolvePluginAdvice(plugin) : null}
        busy={busy}
        onInstall={() => run(installResolvePlugin, setPlugin)}
        onUninstall={() => run(uninstallResolvePlugin, setPlugin)}
      />
      {error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
