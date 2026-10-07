import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getMcpClientSetup: vi.fn(), setMcpOutsideAllowed: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { OutsideControlSection } from "./OutsideControlSection";
import { useMcpStore } from "../../store/useMcpStore";

const SETUP = {
  launch: { program: "/opt/homebrew/bin/uv", args: ["run"], env: [] },
  claudeAdd: "claude mcp add --scope user vibecut -- /opt/homebrew/bin/uv run --locked --extra mcp python -u -m vibecut_agent mcp",
  remoteStart: "claude --remote-control vibecut --tools '' --strict-mcp-config --mcp-config '{}' --allowedTools 'mcp__vibecut__*'",
};

describe("OutsideControlSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getMcpClientSetup.mockResolvedValue(SETUP);
    useMcpStore.setState({ outsideAllowed: false, lastOutsideAt: null, outsideRunning: 0, outsideStep: null });
  });

  it("is off by default and turns on through Rust", async () => {
    ipc.setMcpOutsideAllowed.mockResolvedValue({ outsideAllowed: true, lastOutsideAt: null, folder: "/tmp/mcp" });
    await act(async () => render(<OutsideControlSection />));
    const box = screen.getByRole("checkbox", { name: /Allow Claude Code to edit/ });
    expect(box).not.toBeChecked();
    await act(async () => fireEvent.click(box));
    expect(ipc.setMcpOutsideAllowed).toHaveBeenCalledWith(true);
    expect(useMcpStore.getState().outsideAllowed).toBe(true);
    expect(screen.getByText("No outside calls since the app started.")).toBeInTheDocument();
  });

  it("shows and copies the locked-down remote command and the claude mcp add command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => render(<OutsideControlSection />));
    expect(screen.getByText(SETUP.remoteStart)).toBeInTheDocument();
    expect(screen.getByText(SETUP.claudeAdd)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Copy remote session command/ })));
    expect(writeText).toHaveBeenLastCalledWith(SETUP.remoteStart);
    expect(screen.getByRole("button", { name: /Copied/ })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Copy Claude Code command/ })));
    expect(writeText).toHaveBeenLastCalledWith(SETUP.claudeAdd);
  });

  it("says when Claude Code is calling a tool", async () => {
    useMcpStore.setState({ outsideAllowed: true, outsideRunning: 1 });
    await act(async () => render(<OutsideControlSection />));
    expect(screen.getByText("Claude Code is calling a tool now.")).toBeInTheDocument();
  });
});
