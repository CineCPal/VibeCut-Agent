/**
 * Where the gateway is, by host (visualizer-spec.md §5.3). Standalone (a browser on this Mac or an iPad
 * on the LAN) connects to the page's host on :18765. The embedded modes connect to 127.0.0.1:18765. The
 * app's Telemetry Studio window (src-tauri/src/visualizer.rs) is embedded_tauri on its own: its page is
 * tauri://localhost, whose "localhost" could resolve to ::1 and miss a gateway on 127.0.0.1. Its CSP allows
 * the gateway; the Premiere panel isn't wired.
 *
 * Query parameters: `?mode=standalone|embedded_tauri|embedded_cep`, `?gateway=http://host:port` (or
 * `proxy` for the dev server's same-origin proxy), `?token=` for a LAN gateway, `?trace=` to follow one
 * trace, `?source=mock` for the built-in mock run with no gateway.
 */
import { DEFAULT_GATEWAY_PORT, SSE_PATH, WS_PATH } from "@vibecut/contracts";

export type HostMode = "standalone" | "embedded_tauri" | "embedded_cep";

export interface RuntimeHostAdapter {
  mode: HostMode;
  /** http(s)://host:port, no trailing slash. */
  httpBase: string;
  wsUrl: string;
  sseUrl: string;
  token: string | null;
  traceId: string | null;
  source: "gateway" | "mock";
  /** The layout: the full 4-pane studio, or one column for a narrow panel. */
  compact: boolean;
}

export function resolveHostAdapter(location: Pick<Location, "search" | "hostname" | "host" | "protocol">): RuntimeHostAdapter {
  const params = new URLSearchParams(location.search);
  const modeParam = params.get("mode");
  const inTauri = location.protocol === "tauri:" || location.hostname === "tauri.localhost";
  const mode: HostMode =
    modeParam === "embedded_tauri" || modeParam === "embedded_cep" ? modeParam : inTauri ? "embedded_tauri" : "standalone";
  const gateway = params.get("gateway");
  let httpBase: string;
  if (gateway === "proxy") {
    httpBase = `${location.protocol}//${location.host}`;
  } else if (gateway) {
    httpBase = gateway.replace(/\/+$/, "");
  } else if (mode === "standalone" && location.hostname) {
    const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
    httpBase = `http://${host}:${DEFAULT_GATEWAY_PORT}`;
  } else {
    httpBase = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
  }
  const token = params.get("token");
  const wsBase = httpBase.replace(/^http/, "ws");
  const withToken = (url: string) => (token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url);
  const traceId = params.get("trace");
  return {
    mode,
    httpBase,
    wsUrl: withToken(`${wsBase}${WS_PATH}`),
    sseUrl: withToken(`${httpBase}${SSE_PATH}${traceId ? `?trace_id=${encodeURIComponent(traceId)}` : ""}`),
    token,
    traceId,
    source: params.get("source") === "mock" ? "mock" : "gateway",
    compact: mode === "embedded_cep",
  };
}
