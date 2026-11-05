/**
 * The Telemetry Studio in Premiere's panel (PLAN.md, "The Telemetry Studio in Premiere's panel", V20). The
 * panel is a CEP page from a file, which the gateway lets in only with the key it writes to
 * `<app data>/telemetry/gateway.json`. The panel reads that file with CEP's Node `fs` (src/cep.tsx), and it
 * stamps `studio-panel-alive.json` beside it, which asks the app to keep its gateway running while the
 * panel is open (src-tauri/src/visualizer.rs).
 *
 * Kept apart from cep.tsx, with the file access passed in, so it's tested without CEP.
 */

/** The app's telemetry folder under the home folder (tauri.conf.json's identifier). */
export const APP_TELEMETRY = "Library/Application Support/com.cj.vibecutagent/telemetry";
export const GATEWAY_FILE = "gateway.json";
export const ALIVE_FILE = "studio-panel-alive.json";
/** How often the panel stamps its heartbeat and looks at gateway.json again. */
export const PANEL_POLL_MS = 2000;

export interface PanelGateway {
  url: string;
  panelKey: string;
}

/** gateway.json, if it names a gateway on this Mac (http, loopback) and has a key; null otherwise. */
export function parseGatewayFile(text: string | null): PanelGateway | null {
  if (!text) return null;
  let body: { url?: unknown; panel_key?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.url !== "string" || typeof body.panel_key !== "string" || !body.panel_key) return null;
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) return null;
  return { url: `${url.protocol}//${url.host}`, panelKey: body.panel_key };
}

/** The location the visualizer's host adapter reads (runtimeHostAdapter.ts): the panel's own mode, this
 * gateway and its key. */
export function panelLocation(gateway: PanelGateway): Pick<Location, "search" | "hostname" | "host" | "protocol"> {
  const search = new URLSearchParams({ mode: "embedded_cep", gateway: gateway.url, token: gateway.panelKey });
  return { search: `?${search.toString()}`, hostname: "", host: "", protocol: "file:" };
}

/** The heartbeat's contents: seconds since the epoch, as the app reads it. */
export function aliveStamp(nowMs: number, pid: number | null): string {
  return JSON.stringify({ time: nowMs / 1000, pid });
}

/** What the panel's loop needs from CEP, passed in so it's tested without CEP. */
export interface PanelLoopHost {
  readGateway: () => string | null;
  stampAlive: () => void;
  /** Called with gateway.json's text at the start, and again each time it changes. */
  onGateway: (text: string | null) => void;
  /** Called when the loop stops: whatever `onGateway` started (the telemetry connection and its timers). */
  onStop?: () => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Where the running loop is kept, so the next page finds it: the page's global scope. */
  scope: { __vibecutStudioLoop?: { stop: () => void } };
}

/**
 * The panel's heartbeat and gateway watch, started once per page. CEP's mixed context makes `setInterval`
 * Node's, and Node's timers outlive the page: a reloaded page found the last page's timers still running.
 * One of them, holding an old gateway.json, reloaded the page every 2 s for ever, adding a timer each time
 * (PLAN.md, "The Telemetry Studio reload loop (panel 0.20.3)"). So a page stops whatever loop a previous
 * page left, and a changed gateway restarts the view in place (`onGateway`) instead of reloading.
 */
export function startPanelLoop(host: PanelLoopHost): () => void {
  host.scope.__vibecutStudioLoop?.stop();
  let current = host.readGateway();
  host.stampAlive();
  host.onGateway(current);
  const timer = host.setInterval(() => {
    host.stampAlive();
    const next = host.readGateway();
    if (next === current) return;
    current = next;
    host.onGateway(next);
  }, PANEL_POLL_MS);
  const loop = {
    stop: () => {
      host.clearInterval(timer);
      host.onStop?.();
      if (host.scope.__vibecutStudioLoop === loop) delete host.scope.__vibecutStudioLoop;
    },
  };
  host.scope.__vibecutStudioLoop = loop;
  return loop.stop;
}
