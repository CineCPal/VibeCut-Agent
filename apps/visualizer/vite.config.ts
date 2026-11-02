import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The gateway (src-python/vibecut_agent/telemetry/gateway.py) listens on 127.0.0.1:18765. In dev the
// visualizer can also reach it through this proxy, same-origin (?gateway=proxy).
const GATEWAY = "http://127.0.0.1:18765";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": GATEWAY,
      "/sse": GATEWAY,
      "/ws": { target: GATEWAY.replace("http", "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // One local bundle, about half of it Zod's contracts; served from disk, so no splitting.
    chunkSizeWarningLimit: 700,
  },
});
