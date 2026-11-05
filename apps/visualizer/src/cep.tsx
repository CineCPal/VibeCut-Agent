/**
 * The Telemetry Studio docked in Premiere ("VibeCut Agent Telemetry Studio", src-premiere-panel/studio/;
 * PLAN.md, "The Telemetry Studio in Premiere's panel"). Built as one classic script by vite.cep.config.ts
 * (`npm run build:studio-panel`), because CEP loads the page from a file.
 *
 * CEP runs it with Node (`--enable-nodejs --mixed-context`), which it uses for two things only:
 * - reading gateway.json for the gateway's address and the panel key (lib/host/cepPanel.ts);
 * - stamping studio-panel-alive.json every 2 s, so the app keeps its gateway running while the panel is open.
 *
 * Until there's a gateway it shows a waiting line. When gateway.json appears, changes (a new gateway, a new
 * key) or goes, the view starts again in place with what's there. The page never reloads itself: in CEP's
 * mixed context the timers are Node's and outlive the page, so a reload left the old page's watch running,
 * and it reloaded the page every 2 s (PLAN.md, "The Telemetry Studio reload loop (panel 0.20.3)").
 */
// First: React must never reach Node's queueMicrotask, which crashed the panel on reload (nodeSafeMicrotasks.ts).
import "./lib/host/nodeSafeMicrotasks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ALIVE_FILE, aliveStamp, APP_TELEMETRY, GATEWAY_FILE, panelLocation, parseGatewayFile, startPanelLoop } from "./lib/host/cepPanel";
import { resolveHostAdapter } from "./lib/host/runtimeHostAdapter";
import { startTelemetry } from "./lib/runtime";
import "./styles/index.css";

// CEP's Node, taken at run time so the bundler leaves it alone.
const nodeRequire = (globalThis as unknown as { require: (module: string) => any }).require; // eslint-disable-line @typescript-eslint/no-explicit-any
const fs = nodeRequire("fs");
const os = nodeRequire("os");
const path = nodeRequire("path");
const nodeProcess = (globalThis as unknown as { process?: { pid?: number } }).process;

const folder: string = path.join(os.homedir(), APP_TELEMETRY);

function readGatewayFile(): string | null {
  try {
    return fs.readFileSync(path.join(folder, GATEWAY_FILE), "utf8") as string;
  } catch {
    return null;
  }
}

function stampAlive(): void {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const partial = path.join(folder, `.${ALIVE_FILE}.partial`);
    fs.writeFileSync(partial, aliveStamp(Date.now(), nodeProcess?.pid ?? null), "utf8");
    fs.renameSync(partial, path.join(folder, ALIVE_FILE));
  } catch {
    // The folder can't be written: the app won't start a gateway for the panel, and the waiting line says so.
  }
}

const root = createRoot(document.getElementById("root") as HTMLElement);
/** The running telemetry connection and its timers, for the gateway shown now. */
let stopTelemetry: (() => void) | null = null;

/** Shows this gateway.json (or the waiting line), stopping the connection to the last one first. */
function show(text: string | null): void {
  stopTelemetry?.();
  stopTelemetry = null;
  const gateway = parseGatewayFile(text);
  if (!gateway) {
    root.render(
      <main className="flex h-screen flex-col items-center justify-center gap-2 bg-canvas p-6 text-center text-[13px] text-cool-grey">
        <p className="text-[#e6edf3]">Waiting for VibeCut Agent's telemetry gateway…</p>
        <p>VibeCut Agent starts it while this panel is open. If nothing happens, check the app is running.</p>
      </main>,
    );
    return;
  }
  const adapter = resolveHostAdapter(panelLocation(gateway));
  stopTelemetry = startTelemetry(adapter);
  root.render(
    <StrictMode>
      {/* A new gateway (its key changes each run) gets a fresh view. */}
      <App key={`${gateway.url} ${gateway.panelKey}`} adapter={adapter} />
    </StrictMode>,
  );
}

const stopLoop = startPanelLoop({
  readGateway: readGatewayFile,
  stampAlive,
  onGateway: show,
  onStop: () => {
    stopTelemetry?.();
    stopTelemetry = null;
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  scope: globalThis as Parameters<typeof startPanelLoop>[0]["scope"],
});
// Leaving the page (CEP reloading or closing it) stops the Node timers, which would otherwise outlive it.
window.addEventListener("pagehide", stopLoop);
