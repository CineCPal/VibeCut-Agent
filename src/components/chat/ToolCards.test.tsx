import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { ChatMessage, ChatToolCall } from "../../types/agent";

const card = (id: string, state: ChatToolCall["state"], text = `did ${id}`): ChatMessage => ({
  id,
  role: "tool",
  text,
  createdAt: 1,
  tool: { name: `tool_${id}`, args: '{\n  "a": 1\n}', result: state === "running" ? undefined : '{\n  "ok": true\n}', state },
});
const user: ChatMessage = { id: "u", role: "user", text: "go", createdAt: 1, status: "done" };

describe("tool cards (Phase 8f)", () => {
  it("groups a turn's calls, open while it runs and folded after", () => {
    const messages = [user, card("1", "done"), card("2", "running")];
    const { rerender } = render(<MessageList messages={messages} activity="Running tool_2…" busy />);
    const group = screen.getByRole("button", { name: /2 tool calls/ });
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();

    rerender(<MessageList messages={[user, card("1", "done"), card("2", "failed", "tool_2 failed: nope")]} activity={null} />);
    expect(screen.getByRole("button", { name: /2 tool calls · 1 failed/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("tool_1")).toBeNull();
  });

  it("opens a group and a card from the keyboard, showing arguments and result", () => {
    render(<MessageList messages={[user, card("1", "done")]} activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /1 tool call/ }));
    const toggle = screen.getByRole("button", { name: /tool_1/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/"ok": true/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy arguments" })).toBeInTheDocument();
  });

  it("keeps notes without a card as plain lines, between groups", () => {
    render(<MessageList messages={[user, card("1", "done"), { id: "n", role: "tool", text: "Retrying with Gemini", createdAt: 1 }, card("2", "done")]} activity={null} />);
    expect(screen.getByText("Retrying with Gemini")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /1 tool call/ })).toHaveLength(2);
  });
});
