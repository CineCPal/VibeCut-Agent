import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // The workspaces (apps/visualizer, packages/contracts) run their own suites with their own config.
    exclude: [...configDefaults.exclude, "apps/**", "packages/**"],
  },
});
