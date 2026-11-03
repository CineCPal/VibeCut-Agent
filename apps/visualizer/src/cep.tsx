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
 * key) or goes, the page reloads and starts again with what's there.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ALIVE_FILE, aliveStamp, APP_TELEMETRY, GATEWAY_FILE, PANEL_POLL_MS, panelLocation, parseGatewayFile } from "./lib/host/cepPanel";
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

const started = readGatewayFile();
const gateway = parseGatewayFile(started);
stampAlive();
setInterval(() => {
  stampAlive();
  // A gateway came, went or was replaced (its key changes each run): start again with it.
  if (readGatewayFile() !== started) window.location.reload();
}, PANEL_POLL_MS);

const root = createRoot(document.getElementById("root") as HTMLElement);
if (gateway) {
  const adapter = resolveHostAdapter(panelLocation(gateway));
  startTelemetry(adapter);
  root.render(
    <StrictMode>
      <App adapter={adapter} />
    </StrictMode>,
  );
} else {
  root.render(
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-canvas p-6 text-center text-[13px] text-cool-grey">
      <p className="text-[#e6edf3]">Waiting for VibeCut Agent's telemetry gateway…</p>
      <p>VibeCut Agent starts it while this panel is open. If nothing happens, check the app is running.</p>
    </main>
  );
}
