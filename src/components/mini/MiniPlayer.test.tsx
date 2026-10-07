import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ setMiniPlayer: vi.fn(async (on: boolean) => on), getClaudeCodeUsage: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);
const controller = vi.hoisted(() => ({ sendUserMessage: vi.fn(async () => true), sendEditedMessage: vi.fn(async () => undefined), stopTurn: vi.fn(async () => undefined) }));
vi.mock("../../lib/agent/controller", () => controller);

import { MiniPlayer, nowLine, plainLine } from "./MiniPlayer";
import { useAgentStore } from "../../store/useAgentStore";
import { useUiStore } from "../../store/useUiStore";
import { useUsageStore } from "../../store/useUsageStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useMcpStore } from "../../store/useMcpStore";
import { nleState } from "../../test/nleFixtures";
import type { ChatMessage } from "../../types/agent";

const msg = (role: ChatMessage["role"], text: string): ChatMessage => ({ id: text, role, text, createdAt: 0 });

describe("MiniPlayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve");
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useAgentStore.setState({ messages: [msg("user", "hi"), msg("assistant", "**Cut** the [second take](x) at `01:02:14:00`.")], status: "idle", statusDetail: null, activity: null, draft: "", pendingImages: [], editingMessageId: null });
    useUiStore.setState({ miniPlayer: true });
    useUsageStore.setState({ plan: { status: "allowed", fiveHour: { used: 0.42 }, weekly: { used: 0.03 } }, planAt: 1, days: {}, chats: {} });
    useMcpStore.setState({ outsideRunning: 0 });
  });

  it("reads a reply as one plain line", () => {
    expect(plainLine("## Done\n- **Cut** the [take](u)\n```js\nx\n```\nat `01:00`")).toBe("Done Cut the take at 01:00");
  });

  it("says what the agent is doing while it works, else its last words", () => {
    const messages = [msg("assistant", "Old answer"), msg("user", "next")];
    expect(nowLine(messages, "Running add_markers…", true)).toBe("Running add_markers…");
    expect(nowLine(messages, null, false)).toBe("Old answer");
    expect(nowLine([], null, false)).toBe("Ask VibeCut about your timeline.");
  });

  it("shows the editor, the plan's usage and the last answer", () => {
    render(<MiniPlayer />);
    expect(screen.getByTitle(/^DaVinci Resolve/)).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Cut the second take at 01:02:14:00.")).toBeInTheDocument();
  });

  it("sends from the box with Return and clears it", () => {
    render(<MiniPlayer />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "add a marker" } });
    fireEvent.submit(box.closest("form")!);
    expect(controller.sendUserMessage).toHaveBeenCalledWith("add a marker", []);
    expect(useAgentStore.getState().draft).toBe("");
  });

  it("offers Stop while a turn runs", () => {
    useAgentStore.setState({ status: "thinking", activity: "Calling Claude…" });
    render(<MiniPlayer />);
    expect(screen.getByText("Calling Claude…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(controller.stopTurn).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("expands from its button and from a double-click on the bar, not on its controls", () => {
    render(<MiniPlayer />);
    fireEvent.doubleClick(screen.getByRole("textbox", { name: "Message" }));
    expect(ipc.setMiniPlayer).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole("region", { name: "VibeCut Agent mini player" }));
    expect(ipc.setMiniPlayer).toHaveBeenCalledWith(false);
    useUiStore.setState({ miniPlayer: true });
    fireEvent.click(screen.getByRole("button", { name: "Expand to full window" }));
    expect(ipc.setMiniPlayer).toHaveBeenCalledTimes(2);
  });

  it("Escape clears what was typed", () => {
    render(<MiniPlayer />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "oops" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(useAgentStore.getState().draft).toBe("");
  });
});
