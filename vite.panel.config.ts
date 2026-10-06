import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the "VibeCut Agent B-roll" panel docked in Premiere (PLAN.md, "Phase 5b") as one classic script
 * plus its CSS, into src-premiere-panel/broll/dist/ (shipped with the panel). After VibeCut's
 * src-host-panel/vite.config.ts `--mode cep`. Run with `npm run build:panel`.
 */
export default defineConfig({
  root: `${import.meta.dirname}/src-premiere-panel-ui`,
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: `${import.meta.dirname}/src-premiere-panel/broll/dist`,
    emptyOutDir: true,
    // CEP 12's Chromium.
    target: "es2020",
    cssCodeSplit: false,
    lib: {
      entry: `${import.meta.dirname}/src-premiere-panel-ui/cep.tsx`,
      formats: ["iife"],
      name: "VibeCutAgentBrollPanel",
      fileName: () => "panel.js",
      cssFileName: "panel",
    },
  },
});
