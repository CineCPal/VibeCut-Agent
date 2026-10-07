import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getClaudeCodeUsage: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { UsageMeter } from "./UsageMeter";
import { useUsageStore } from "../../store/useUsageStore";
import { useSystemStore } from "../../store/useSystemStore";
import { useAgentStore } from "../../store/useAgentStore";

const signedIn = { program: "/u/claude", programSaved: null, configDir: null, signedIn: true, email: null, subscription: "team", detail: null };

describe("UsageMeter (Phase 9b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUsageStore.setState({ plan: null, planAt: null, days: {}, chats: {} });
    useSystemStore.setState({ claudeCode: signedIn });
    useAgentStore.setState({ chatId: "chat-1" });
  });

  it("shows the 5-hour window, warning colours near the limit", () => {
    useUsageStore.setState({ plan: { status: "allowed_warning", fiveHour: { used: 0.8 }, weekly: { used: 0.5 } }, planAt: Date.now() });
    render(<UsageMeter />);
    const pill = screen.getByRole("button", { name: /Claude plan: 80% of the 5-hour limit, 50% of the week/ });
    expect(pill).toHaveTextContent("80%");
    expect(screen.getByText("80%")).toHaveClass("text-warning");
  });

  it("opens the details: both windows, this chat and today", () => {
    const now = Date.now();
    useUsageStore.setState({ plan: { fiveHour: { used: 0.42, resetsAt: now / 1000 + 3600 }, weekly: { used: 0.03, resetsText: "Oct 13 at 12:59am (America/New_York)" } }, planAt: now });
    useUsageStore.getState().addTurn("claude-sonnet-5-5", "chat-1", { promptTokens: 12_000, cachedTokens: 0, outputTokens: 800, thoughtsTokens: 0, steps: 1 });
    render(<UsageMeter />);
    fireEvent.click(screen.getByRole("button", { name: /Claude plan/ }));
    expect(screen.getByRole("meter", { name: "5-hour limit used" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Resets in 1 h 0 m")).toBeInTheDocument();
    expect(screen.getByText("Resets Oct 13 at 12:59am")).toBeInTheDocument();
    expect(screen.getByText(/13k tokens · 1 turn · \$0.03/)).toBeInTheDocument();
    expect(screen.getAllByText("Claude Sonnet 5.5")).toHaveLength(2);
  });

  it("refreshes from Claude Code's /usage", async () => {
    ipc.getClaudeCodeUsage.mockResolvedValue("Current session: 7% used · resets Oct 7 at 3pm\nCurrent week (all models): 4% used");
    render(<UsageMeter />);
    fireEvent.click(screen.getByRole("button", { name: /Today/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(useUsageStore.getState().plan?.fiveHour?.used).toBe(0.07));
  });

  it("says why it can't refresh", async () => {
    ipc.getClaudeCodeUsage.mockRejectedValue(new Error("Claude Code didn't answer within 20 s."));
    render(<UsageMeter />);
    fireEvent.click(screen.getByRole("button", { name: /Today/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Claude Code didn't answer within 20 s.")).toBeInTheDocument();
  });
});
