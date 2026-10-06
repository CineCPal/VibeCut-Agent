import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const controller = vi.hoisted(() => ({ sendUserMessage: vi.fn(), stopTurn: vi.fn() }));
vi.mock("../../lib/agent/controller", () => controller);

import { Composer, composerBlockReason } from "./Composer";
import { AGENT_OFFLINE_DETAIL, useAgentStore } from "../../store/useAgentStore";

describe("Composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({ messages: [], status: "offline", statusDetail: AGENT_OFFLINE_DETAIL, draft: "" });
  });

  it("explains why it can't send", () => {
    expect(composerBlockReason("offline", null)).toBe("Agent offline");
    expect(composerBlockReason("thinking", null)).toBe("Agent is working…");
    expect(composerBlockReason("stopping", null)).toBe("Stopping…");
    expect(composerBlockReason("error", "uv not found")).toBe("uv not found");
    expect(composerBlockReason("idle", null)).toBeNull();
  });

  it("is disabled with the reason while the agent is offline", () => {
    render(<Composer />);
    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText(AGENT_OFFLINE_DETAIL)).toBeInTheDocument();
  });

  it("sends on Enter when idle and keeps Shift+Enter as a newline", () => {
    useAgentStore.setState({ status: "idle", statusDetail: null });
    render(<Composer />);
    const input = screen.getByLabelText("Message the agent");

    fireEvent.change(input, { target: { value: "Duck the music under dialogue" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(controller.sendUserMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(controller.sendUserMessage).toHaveBeenCalledWith("Duck the music under dialogue");
    expect(useAgentStore.getState().draft).toBe("");
  });

  it("does not send blank drafts", () => {
    useAgentStore.setState({ status: "idle", statusDetail: null, draft: "   " });
    render(<Composer />);
    fireEvent.keyDown(screen.getByLabelText("Message the agent"), { key: "Enter" });
    expect(controller.sendUserMessage).not.toHaveBeenCalled();
  });

  it("offers Stop while a turn runs", () => {
    useAgentStore.setState({ status: "thinking", statusDetail: null });
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(controller.stopTurn).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Agent is working…")).toBeInTheDocument();
  });
});
