// First: React must never reach Node's queueMicrotask (nodeSafeMicrotasks.ts).
import "./nodeSafeMicrotasks";
import { createRoot } from "react-dom/client";
import { installEditKeys, pasteboard } from "./editKeys";
import { HostApp } from "./HostApp";
import { fillDrag } from "./fillDrag";
import { fileTransport, panelChatDir, type FileOps } from "./transport";
import "./panel.css";

/**
 * Premiere's dockable "VibeCut Agent" panel (src-premiere-panel/chat/, Window → Extensions → VibeCut
 * Agent; `vibecut.host.panels.v1`): Chat · B-roll · History over the menu-bar app's own conversation. The
 * same CEP Node `fs` as the B-roll panel (cep.tsx), pointed at the chat folder, with CEP's file drag for
 * B-roll cards, CEP's folder picker for the Analyze tab, and the editing keys (editKeys.ts).
 */

// CEP's Node, taken at run time so the bundler leaves it alone.
const nodeRequire = (globalThis as unknown as { require: (module: string) => any }).require; // eslint-disable-line @typescript-eslint/no-explicit-any
const fs = nodeRequire("fs");
const os = nodeRequire("os");

const ops: FileOps = {
  async readText(path) {
    try {
      return (await fs.promises.readFile(path, "utf8")) as string;
    } catch {
      return null;
    }
  },
  async writeText(path, text) {
    await fs.promises.writeFile(path, text, "utf8");
  },
  async rename(from, to) {
    await fs.promises.rename(from, to);
  },
  async makeDir(path) {
    await fs.promises.mkdir(path, { recursive: true });
  },
};

/** CEP's own folder dialog (`window.cep.fs`, part of every CEP panel). */
interface CepFs {
  showOpenDialogEx?: (multiple: boolean, folders: boolean, title: string, initialPath?: string) => { err: number; data: string[] };
}
const cepFs = (window as unknown as { cep?: { fs?: CepFs } }).cep?.fs;

function chooseFolder(current: string | null): Promise<string | null> {
  const picked = cepFs?.showOpenDialogEx?.(false, true, "Choose a folder of B-roll", current ?? undefined);
  return Promise.resolve(picked && picked.err === 0 && picked.data?.[0] ? picked.data[0] : null);
}

const clipboard = pasteboard(nodeRequire);
installEditKeys(clipboard);

const root = document.getElementById("root");
if (root) {
  try {
    const transport = fileTransport(panelChatDir(os.homedir(), "premiere"), ops, {
      fillDrag,
      copyText: clipboard.write,
      ...(cepFs?.showOpenDialogEx ? { chooseFolder } : {}),
    });
    createRoot(root).render(<HostApp transport={transport} hostName="Premiere Pro" />);
  } catch (error) {
    root.textContent = `VibeCut Agent's panel couldn't start: ${error instanceof Error ? error.message : String(error)}`;
  }
}
