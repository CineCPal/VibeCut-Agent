import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getKeepOnTop: vi.fn(), setKeepOnTop: vi.fn(), onKeepOnTop: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
vi.mock("../components/chat/ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("../components/broll/LibraryPanel", () => ({ LibraryPanel: () => null }));
vi.mock("../components/broll/FolderAnalyzer", () => ({ FolderAnalyzer: () => null }));
vi.mock("../components/layout/NleStatusPill", () => ({ NleStatusPill: () => null }));

import { toggleKeepOnTop, useKeepOnTop } from "./useKeepOnTop";
import { AppShell } from "../components/layout/AppShell";
import { useUiStore } from "../store/useUiStore";

function Harness() {
  useKeepOnTop();
  return <AppShell />;
}

describe("Keep on Top of Editors", () => {
  let push: (on: boolean) => void = () => undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ keepOnTop: null });
    ipc.getKeepOnTop.mockResolvedValue(true);
    ipc.setKeepOnTop.mockImplementation(async (on: boolean) => on);
    ipc.onKeepOnTop.mockImplementation(async (handler: (on: boolean) => void) => {
      push = handler;
      return () => undefined;
    });
  });

  it("shows the pin once Rust has said, and toggles it", async () => {
    render(<Harness />);
    const pin = await screen.findByRole("button", { name: "Keep on top of editors" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pin);
    expect(ipc.setKeepOnTop).toHaveBeenCalledWith(false);
    expect(pin).toHaveAttribute("aria-pressed", "false");
  });

  it("follows a change made from the tray menu", async () => {
    render(<Harness />);
    await screen.findByRole("button", { name: "Keep on top of editors" });
    push(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep on top of editors" })).toHaveAttribute("aria-pressed", "false"));
  });

  it("puts the pin back if Rust couldn't save the change", async () => {
    useUiStore.setState({ keepOnTop: true });
    ipc.setKeepOnTop.mockRejectedValue(new Error("read-only config"));
    await toggleKeepOnTop(false);
    expect(useUiStore.getState().keepOnTop).toBe(true);
  });
});
