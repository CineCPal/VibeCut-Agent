import { createRoot } from "react-dom/client";
import { HostApp } from "./HostApp";
import { fileTransport, type FileOps, type Transport } from "./transport";
import "./panel.css";

/**
 * DaVinci Resolve Studio's Workflow Integration plugin (src-resolve-plugin/, `com.vibecutagent.resolve`):
 * the "VibeCut Agent" panel in a sandboxed Electron renderer, after VibeCut's src-host-panel electron.tsx.
 * The plugin's preload exposes `window.vibecutPanel`, whose file calls go to its main process, which only
 * touches VibeCut Agent's chat folder for Resolve.
 */

interface PanelBridge {
  chatDir: string;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  /** A real file drag of a B-roll shot, by its key; the main process finds the file in broll.json. */
  startDrag(key: string): void;
  /** Resolve's folder dialog (plugin 0.20.0). */
  chooseFolder?(current: string | null): Promise<string | null>;
  /** Puts text on the pasteboard (plugin 0.20.0). */
  copyText?(text: string): Promise<void>;
}

const bridge = (window as unknown as { vibecutPanel: PanelBridge }).vibecutPanel;

const ops: FileOps = {
  readText: (path) => bridge.readText(path),
  writeText: (path, text) => bridge.writeText(path, text),
  rename: (from, to) => bridge.rename(from, to),
  makeDir: (path) => bridge.makeDir(path),
};

/** The B-roll cards drag a shot's file path; Electron's drag names the shot's key, as `broll.json` lists it. */
function withNativeDrag(transport: Transport): Transport {
  let keys = new Map<string, string>();
  return {
    ...transport,
    async readBroll() {
      const file = await transport.readBroll();
      if (file) keys = new Map(Object.entries(file.paths).map(([key, path]) => [path, key]));
      return file;
    },
    fillDrag(path) {
      const key = keys.get(path);
      if (key) bridge.startDrag(key);
      // The HTML drag is cancelled: Electron's own drag carries the file into Resolve.
      return false;
    },
  };
}

const root = document.getElementById("root");
if (root) {
  try {
    const transport = withNativeDrag(
      fileTransport(bridge.chatDir, ops, {
        ...(bridge.chooseFolder ? { chooseFolder: (current: string | null) => bridge.chooseFolder!(current) } : {}),
        ...(bridge.copyText ? { copyText: (text: string) => void bridge.copyText!(text) } : {}),
      }),
    );
    createRoot(root).render(<HostApp transport={transport} hostName="DaVinci Resolve" />);
  } catch (error) {
    root.textContent = `VibeCut Agent's panel couldn't start: ${error instanceof Error ? error.message : String(error)}`;
  }
}
