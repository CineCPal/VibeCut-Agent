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
