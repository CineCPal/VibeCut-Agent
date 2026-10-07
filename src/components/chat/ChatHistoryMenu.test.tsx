import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const history = vi.hoisted(() => ({ openChat: vi.fn(), deleteChat: vi.fn() }));
vi.mock("../../lib/agent/chatHistory", () => history);

import { ChatHistoryMenu, relativeTime } from "./ChatHistoryMenu";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useUiStore } from "../../store/useUiStore";

const NOW = Date.now();
const chats = [
  { id: "c1", title: "Tighten the interview", createdAt: NOW - 120_000, updatedAt: NOW - 120_000, messageCount: 6 },
  { id: "c2", title: "Mark the hook", createdAt: NOW - 90_000_000, updatedAt: NOW - 90_000_000, messageCount: 1 },
];

describe("ChatHistoryMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    history.openChat.mockResolvedValue(undefined);
    history.deleteChat.mockResolvedValue(undefined);
    useChatHistoryStore.setState({ chats, saveError: null });
    useAgentStore.setState({ chatId: "c1" });
    useUiStore.setState({ historyOpen: false });
  });

  it("says how long ago, in words", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
  });

  it("lists past chats, newest first, with the open one marked", () => {
    render(<ChatHistoryMenu busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Tighten the interview");
    expect(options[0]).toHaveTextContent("Open now · 2 min ago · 6 messages");
    expect(options[1]).toHaveTextContent("yesterday · 1 message");
    expect(screen.getByRole("listbox", { name: "Past chats" })).toHaveFocus();
  });

  it("opens a chat from the keyboard and closes", async () => {
    useUiStore.setState({ historyOpen: true });
    render(<ChatHistoryMenu busy={false} />);
    const list = screen.getByRole("listbox", { name: "Past chats" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await act(async () => fireEvent.keyDown(list, { key: "Enter" }));
    expect(history.openChat).toHaveBeenCalledWith("c2");
    expect(useUiStore.getState().historyOpen).toBe(false);
  });

  it("deletes only on the second press, and Escape backs out first", async () => {
    useUiStore.setState({ historyOpen: true });
    render(<ChatHistoryMenu busy={false} />);
    const list = screen.getByRole("listbox", { name: "Past chats" });
    await act(async () => fireEvent.keyDown(list, { key: "Delete" }));
    expect(history.deleteChat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Confirm deleting "Tighten the interview"' })).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(useUiStore.getState().historyOpen).toBe(true);
    await act(async () => fireEvent.keyDown(list, { key: "Delete" }));
    await act(async () => fireEvent.keyDown(list, { key: "Delete" }));
    expect(history.deleteChat).toHaveBeenCalledWith("c1");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(useUiStore.getState().historyOpen).toBe(false);
  });

  it("can be read but not switched while a request runs", async () => {
    useUiStore.setState({ historyOpen: true });
    render(<ChatHistoryMenu busy />);
    await act(async () => fireEvent.click(screen.getAllByRole("option")[1]));
    expect(history.openChat).not.toHaveBeenCalled();
    expect(screen.getByText("Finish or stop the current request to switch chats.")).toBeInTheDocument();
  });

  it("says why a chat couldn't be opened", async () => {
    history.openChat.mockRejectedValue(new Error("That chat can't be read"));
    useUiStore.setState({ historyOpen: true });
    render(<ChatHistoryMenu busy={false} />);
    await act(async () => fireEvent.click(screen.getAllByRole("option")[1]));
    expect(screen.getByRole("alert")).toHaveTextContent("That chat can't be read");
    expect(useUiStore.getState().historyOpen).toBe(true);
  });

  it("is disabled with no past chats", () => {
    useChatHistoryStore.setState({ chats: [] });
    render(<ChatHistoryMenu busy={false} />);
    expect(screen.getByRole("button", { name: "History" })).toBeDisabled();
  });
});
