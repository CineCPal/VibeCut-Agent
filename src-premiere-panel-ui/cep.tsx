import { createRoot } from "react-dom/client";
import { BrollApp } from "./BrollApp";
import { fillDrag } from "./fillDrag";
import { fileTransport, panelDir, type FileOps } from "./transport";
import "./panel.css";

/**
 * Premiere's docked "VibeCut Agent B-roll" panel (src-premiere-panel/broll/, PLAN.md "Phase 5b"), after
 * VibeCut's src-host-panel/src/cep.tsx. A CEP panel because Premiere takes a file dragged from a CEP
 * panel (CEP's `com.adobe.cep.dnd.file.0`) into its Project panel and timeline, with its insert marker,
 * as from Finder; a drag from another app's window doesn't get that. CEP runs it with Node
 * (`--enable-nodejs --mixed-context`), so it reads and writes its folder with `fs`.
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

const root = document.getElementById("root");
if (root) {
  try {
    const transport = fileTransport(panelDir(os.homedir()), ops, { fillDrag });
    createRoot(root).render(<BrollApp transport={transport} />);
  } catch (error) {
    root.textContent = `VibeCut Agent's B-roll panel couldn't start: ${error instanceof Error ? error.message : String(error)}`;
  }
}
