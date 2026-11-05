import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the panels that run inside the editors, each as one classic script plus its CSS (after VibeCut's
 * src-host-panel/vite.config.ts). `--mode` picks which:
 * - `broll` (the default): the "VibeCut Agent Library" panel docked in Premiere (PLAN.md, "Phase 5b"),
 *   into src-premiere-panel/broll/dist/.
 * - `chat`: the full "VibeCut Agent" panel docked in Premiere (`vibecut.host.panels.v1`), into
 *   src-premiere-panel/chat/dist/.
 * - `resolve`: the same panel in DaVinci Resolve's Workflow Integration plugin, into
 *   src-resolve-plugin/dist/.
 * `npm run build:panel` builds all three.
 */
const here = import.meta.dirname;

const TARGETS = {
  broll: { entry: "cep.tsx", outDir: "src-premiere-panel/broll/dist", name: "VibeCutAgentBrollPanel" },
  chat: { entry: "cepChat.tsx", outDir: "src-premiere-panel/chat/dist", name: "VibeCutAgentChatPanel" },
  resolve: { entry: "electron.tsx", outDir: "src-resolve-plugin/dist", name: "VibeCutAgentResolvePanel" },
} as const;

export default defineConfig(({ mode }) => {
  const target = TARGETS[mode as keyof typeof TARGETS] ?? TARGETS.broll;
  return {
    root: `${here}/src-premiere-panel-ui`,
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: `${here}/${target.outDir}`,
      emptyOutDir: true,
      // CEP 12's Chromium; Resolve's Electron is newer.
      target: "es2020",
      cssCodeSplit: false,
      lib: {
        entry: `${here}/src-premiere-panel-ui/${target.entry}`,
        formats: ["iife"],
        name: target.name,
        fileName: () => "panel.js",
        cssFileName: "panel",
      },
    },
  };
});
