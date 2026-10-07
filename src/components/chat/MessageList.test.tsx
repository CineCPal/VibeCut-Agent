import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageList, type TurnActions } from "./MessageList";
import type { ChatMessage } from "../../types/agent";

const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: "m", role: "assistant", text: "", createdAt: 1, ...over });

describe("MessageList", () => {
  it("shows a streaming reply with a caret, hidden from screen readers until it's finished", () => {
    const { rerender } = render(<MessageList messages={[msg({ text: "Trimming the", status: "pending" })]} activity="Calling Gemini…" />);
    expect(screen.getByText("Agent is replying…")).toBeInTheDocument();
    const busy = screen.getByRole("article", { hidden: true });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Trimming the").closest("[aria-hidden]")).not.toBeNull();
    // The activity line gives way to the reply itself.
    expect(screen.queryByText("Calling Gemini…")).toBeNull();

    rerender(<MessageList messages={[msg({ text: "Trimming the intro.", status: "done" })]} activity={null} />);
    expect(screen.queryByText("Agent is replying…")).toBeNull();
    expect(screen.getByText("Trimming the intro.").closest("[aria-hidden]")).toBeNull();
  });

  it("announces new messages only, not every streamed change", () => {
    render(<MessageList messages={[]} activity={null} />);
    expect(screen.getByRole("log")).toHaveAttribute("aria-relevant", "additions");
  });

  it("copies a message's text", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<MessageList messages={[msg({ text: "Cut at 00:12." })]} activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith("Cut at 00:12.");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("offers Retry under the last turn and Edit on its message, naming edits it would revert", () => {
    const turn: TurnActions = { userMessageId: "u", blocked: null, edits: 2, onRetry: vi.fn(), onEdit: vi.fn() };
    const messages = [msg({ id: "u", role: "user", text: "trim" }), msg({ id: "a", text: "Trimmed." })];
    render(<MessageList messages={messages} activity={null} turn={turn} />);
    fireEvent.click(screen.getByRole("button", { name: /Revert 2 edits & retry/ }));
    expect(turn.onRetry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit your last message" }));
    expect(turn.onEdit).toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Edit your last message" })).toHaveLength(1);
  });

  it("shows why Retry can't run, and hides it while a reply streams", () => {
    const turn: TurnActions = { userMessageId: "u", blocked: "Edits were made after this request; revert those first", edits: 0, onRetry: vi.fn(), onEdit: vi.fn() };
    const { rerender } = render(<MessageList messages={[msg({ id: "u", role: "user", text: "go" })]} activity={null} turn={turn} />);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Retry/ })).toHaveAttribute("title", turn.blocked);
    rerender(<MessageList messages={[msg({ id: "u", role: "user", text: "go" }), msg({ id: "a", status: "pending", text: "…" })]} activity={null} turn={turn} />);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});
