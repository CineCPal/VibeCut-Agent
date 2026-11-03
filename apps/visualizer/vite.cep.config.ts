import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Builds the Telemetry Studio for Premiere's docked panel (src/cep.tsx; PLAN.md, "The Telemetry Studio in
 * Premiere's panel") as one classic script plus its CSS, into src-premiere-panel/studio/dist/ (shipped with
 * the panel), as vite.panel.config.ts does for the B-roll panel. Run with `npm run build:studio-panel`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // No public/ copy: the avatars are drawn (V8), and the panel ships only what PANEL_FILES lists.
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: `${import.meta.dirname}/../../src-premiere-panel/studio/dist`,
    emptyOutDir: true,
    // CEP 12's Chromium, for the script and the stylesheet alike (Tailwind's colors lowered to what it reads).
    target: "es2020",
    cssTarget: "chrome99",
    cssCodeSplit: false,
    chunkSizeWarningLimit: 900,
    lib: {
      entry: `${import.meta.dirname}/src/cep.tsx`,
      formats: ["iife"],
      name: "VibeCutTelemetryStudioPanel",
      fileName: () => "studio.js",
      cssFileName: "studio",
    },
  },
});
