import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { resolveHostAdapter } from "./lib/host/runtimeHostAdapter";
import { startTelemetry } from "./lib/runtime";
import "./styles/index.css";

const adapter = resolveHostAdapter(window.location);
startTelemetry(adapter);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App adapter={adapter} />
  </StrictMode>,
);
