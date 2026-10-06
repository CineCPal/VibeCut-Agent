import type { SessionStatus } from "../types/sidecar";

export function sessionLabel(session: SessionStatus): string {
  switch (session.state) {
    case "starting":
      return "Starting…";
    case "ready":
      return session.python ? `Running · Python ${session.python}` : "Running";
    case "stopped":
      return session.message ? "Stopped with an error" : "Stopped";
  }
}
