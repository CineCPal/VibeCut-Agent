import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { NleState } from "../types/nle";
import { nleState } from "../test/nleFixtures";

const push = vi.hoisted(() => ({ handler: null as ((state: NleState) => void) | null }));
const unlisten = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  getNleState: vi.fn(),
  onNleState: vi.fn(async (handler: (state: NleState) => void) => {
    push.handler = handler;
    return unlisten;
  }),
}));
vi.mock("../lib/ipc", () => ipc);

import { useNleBridge } from "./useNleBridge";
import { initialHosts, useNleStateStore } from "../store/useNleStateStore";

function Harness() {
  useNleBridge();
  return null;
}

describe("useNleBridge", () => {
  beforeEach(() => {
    unlisten.mockClear();
    useNleStateStore.setState({ hosts: initialHosts() });
    ipc.getNleState.mockResolvedValue([
      nleState("premiere", { status: "disconnected", message: "Premiere Pro isn't running.", changedAt: 5 }),
      nleState("resolve", { changedAt: 5 }),
    ]);
  });

  it("reads both editors on mount and follows pushes", async () => {
    const view = render(<Harness />);
    await act(async () => undefined);
    expect(useNleStateStore.getState().hosts.premiere.message).toBe("Premiere Pro isn't running.");
    expect(useNleStateStore.getState().hosts.resolve.status).toBe("connected");

    act(() => push.handler?.(nleState("premiere", { reason: "restarted", changedAt: 6 })));
    expect(useNleStateStore.getState().hosts.premiere).toMatchObject({ status: "connected", reason: "restarted" });

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
