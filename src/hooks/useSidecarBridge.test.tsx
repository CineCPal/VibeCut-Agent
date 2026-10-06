import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { SessionStatus, SidecarEventPayload, SidecarExitPayload } from "../types/sidecar";

type Handler<T> = (payload: T) => void;
const handlers = vi.hoisted(() => ({
  session: null as Handler<SessionStatus> | null,
  event: null as Handler<SidecarEventPayload> | null,
  exit: null as Handler<SidecarExitPayload> | null,
}));
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", () => ({
  SESSION_JOB_ID: "agent-session",
  getSessionStatus: vi.fn().mockResolvedValue({ state: "ready", version: "0.1.0", python: "3.14.0", message: null }),
  onSessionStatus: vi.fn(async (h: Handler<SessionStatus>) => ((handlers.session = h), unlisten)),
  onSidecarEvent: vi.fn(async (h: Handler<SidecarEventPayload>) => ((handlers.event = h), unlisten)),
  onSidecarExit: vi.fn(async (h: Handler<SidecarExitPayload>) => ((handlers.exit = h), unlisten)),
}));

import { useSidecarBridge } from "./useSidecarBridge";
import { INITIAL_SESSION, useSidecarStore } from "../store/useSidecarStore";

function Harness() {
  useSidecarBridge();
  return null;
}

describe("useSidecarBridge", () => {
  beforeEach(() => {
    unlisten.mockClear();
    useSidecarStore.setState({ session: INITIAL_SESSION, jobs: [] });
  });

  it("reads the session status on mount and follows pushed changes", async () => {
    const view = render(<Harness />);
    await act(async () => undefined);
    expect(useSidecarStore.getState().session.state).toBe("ready");

    act(() => handlers.session?.({ state: "stopped", version: null, python: null, message: "Traceback" }));
    expect(useSidecarStore.getState().session).toMatchObject({ state: "stopped", message: "Traceback" });

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("routes job events to the store but leaves session events alone", async () => {
    useSidecarStore.getState().addJob({ id: "j1", command: "health", label: "Health" });
    render(<Harness />);
    await act(async () => undefined);

    act(() => handlers.event?.({ jobId: "j1", command: "health", event: { type: "progress", fraction: 0.5 } }));
    act(() => handlers.event?.({ jobId: "agent-session", command: "session", event: { type: "pong" } }));
    act(() => handlers.exit?.({ jobId: "j1", code: 0, cancelled: false, message: null }));

    expect(useSidecarStore.getState().jobs[0]).toMatchObject({ status: "done", fraction: 1 });
  });
});
