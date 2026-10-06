import { useEffect } from "react";
import { getSessionStatus, onSessionStatus, onSidecarEvent, onSidecarExit, SESSION_JOB_ID } from "../lib/ipc";
import { useSidecarStore } from "../store/useSidecarStore";
import type { SessionStatus } from "../types/sidecar";

/**
 * Feeds Rust's sidecar events into the stores: the agent session's state (read once on mount, then
 * pushed as `sidecar-session`) and the progress and exit of one-shot jobs.
 */
export function useSidecarBridge(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];

    // The agent's availability follows from the session (useAgent / refreshAgentStatus).
    const applySession = (session: SessionStatus) => useSidecarStore.getState().setSession(session);

    const keep = (promise: Promise<() => void>) =>
      promise
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);

    keep(onSessionStatus(applySession));
    keep(
      onSidecarEvent(({ jobId, event }) => {
        if (jobId !== SESSION_JOB_ID) useSidecarStore.getState().applyEvent(jobId, event);
      }),
    );
    keep(
      onSidecarExit((exit) => {
        if (exit.jobId !== SESSION_JOB_ID) useSidecarStore.getState().applyExit(exit);
      }),
    );

    getSessionStatus()
      .then((session) => {
        if (!disposed) applySession(session);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);
}
