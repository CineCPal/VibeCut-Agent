import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const edits = vi.hoisted(() => ({ revertLastRequest: vi.fn() }));
vi.mock("../../lib/agent/edits", () => edits);
vi.mock("../../lib/agent/controller", () => ({ newConversation: vi.fn(), sendUserMessage: vi.fn(), stopTurn: vi.fn() }));

import { ChatPanel } from "./ChatPanel";
import { useAgentStore } from "../../store/useAgentStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { EditEntry } from "../../types/edits";

const entry = (id: string, step: string, reverted = false): EditEntry => ({
  id,
  step,
  stepText: "",
  at: 0,
  host: "premiere",
  timeline: "Main",
  tool: "delete_clips",
  summary: "",
  backup: "B",
  changes: [],
  ...(reverted ? { reverted: { at: 1, changedSince: 0, failed: 0, lost: [] } } : {}),
});

describe("ChatPanel revert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({ messages: [{ id: "u", role: "user", text: "tidy", createdAt: 0 }], status: "idle", statusDetail: null, activity: null });
  });

  it("offers to revert the latest request's edits and reports the outcome", async () => {
    useEditLogStore.setState({ entries: [entry("e1", "m1"), entry("e2", "m2"), entry("e3", "m2")] });
    edits.revertLastRequest.mockResolvedValue({ summary: "Reverted 2 timeline changes", result: {} });
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revert 2 edits" })));
    expect(edits.revertLastRequest).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().messages.at(-1)).toMatchObject({ role: "tool", text: "Reverted 2 timeline changes" });
  });

  it("says why a revert failed, and hides when nothing is left to revert", async () => {
    useEditLogStore.setState({ entries: [entry("e1", "m1")] });
    edits.revertLastRequest.mockRejectedValue(new Error("Premiere Pro isn't running."));
    const view = render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revert 1 edit" })));
    expect(useAgentStore.getState().messages.at(-1)).toMatchObject({ role: "error", text: "Premiere Pro isn't running." });
    view.unmount();
    useEditLogStore.setState({ entries: [entry("e1", "m1", true)] });
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: /Revert/ })).toBeNull();
  });

  it("says when the latest request's edits are from before the app restarted", () => {
    useEditLogStore.setState({ entries: [entry("e1", "m1"), { ...entry("e2", "m2"), fromEarlierRun: true }] });
    render(<ChatPanel />);
    const button = screen.getByRole("button", { name: "Revert 1 edit (earlier session)" });
    expect(button).toHaveAttribute("title", expect.stringContaining("Clips changed since are left as they are"));
  });

  it("can't revert while the agent is working", () => {
    useEditLogStore.setState({ entries: [entry("e1", "m1")] });
    useAgentStore.setState({ status: "thinking" });
    render(<ChatPanel />);
    expect(screen.getByRole("button", { name: "Revert 1 edit" })).toBeDisabled();
  });
});
