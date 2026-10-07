import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getMiniPlayer: vi.fn(), setMiniPlayer: vi.fn(), onMiniPlayer: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);

import { toggleMiniPlayer, useMiniPlayer } from "./useMiniPlayer";
import { togglesMiniPlayer, useHotkeys } from "./useHotkeys";
import { useUiStore } from "../store/useUiStore";

function Harness() {
  useMiniPlayer();
  useHotkeys();
  return null;
}

const mods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("Mini Player (Phase 9c)", () => {
  let push: (on: boolean) => void = () => undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ miniPlayer: false, overlay: null, historyOpen: false, tab: "chat" });
    ipc.getMiniPlayer.mockResolvedValue(false);
    ipc.setMiniPlayer.mockImplementation(async (on: boolean) => on);
    ipc.onMiniPlayer.mockImplementation(async (handler: (on: boolean) => void) => {
      push = handler;
      return () => undefined;
    });
  });

  it("is ⌥⌘M (by key position, since ⌥M types µ), and Ctrl+Alt+M", () => {
    expect(togglesMiniPlayer({ ...mods, code: "KeyM", metaKey: true, altKey: true })).toBe(true);
    expect(togglesMiniPlayer({ ...mods, code: "KeyM", ctrlKey: true, altKey: true })).toBe(true);
    expect(togglesMiniPlayer({ ...mods, code: "KeyM", metaKey: true })).toBe(false);
    expect(togglesMiniPlayer({ ...mods, code: "KeyM", metaKey: true, altKey: true, shiftKey: true })).toBe(false);
  });

  it("follows Rust and toggles from the hotkey, closing overlays on the way in", async () => {
    render(<Harness />);
    await waitFor(() => expect(ipc.onMiniPlayer).toHaveBeenCalled());
    useUiStore.setState({ overlay: "settings", historyOpen: true });
    fireEvent.keyDown(window, { key: "µ", code: "KeyM", metaKey: true, altKey: true });
    expect(ipc.setMiniPlayer).toHaveBeenCalledWith(true);
    expect(useUiStore.getState()).toMatchObject({ miniPlayer: true, overlay: null, historyOpen: false });
    push(false);
    expect(useUiStore.getState().miniPlayer).toBe(false);
  });

  it("expands before opening a view from a hotkey", async () => {
    useUiStore.setState({ miniPlayer: true });
    render(<Harness />);
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(ipc.setMiniPlayer).toHaveBeenCalledWith(false);
    expect(useUiStore.getState()).toMatchObject({ miniPlayer: false, overlay: "settings" });
  });

  it("goes back when Rust refuses", async () => {
    ipc.setMiniPlayer.mockRejectedValue(new Error("The main window is gone"));
    await toggleMiniPlayer(true);
    expect(useUiStore.getState().miniPlayer).toBe(false);
  });
});
