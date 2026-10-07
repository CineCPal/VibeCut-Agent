import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ chooseFile: vi.fn(), chooseFolder: vi.fn(), setClaudeCode: vi.fn(), getClaudeCodeStatus: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { ClaudeCodeSection } from "./ClaudeCodeSection";
import { useSystemStore } from "../../store/useSystemStore";
import type { ClaudeCodeStatus } from "../../types/agent";

const status = (over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus => ({
  program: "/Users/me/.local/bin/claude",
  programSaved: null,
  configDir: null,
  signedIn: true,
  email: "me@example.com",
  subscription: "pro",
  detail: null,
  ...over,
});

describe("ClaudeCodeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStore.setState({ claudeCode: status() });
  });

  it("shows who Claude Code is signed in as, and where it runs from", () => {
    render(<ClaudeCodeSection />);
    expect(screen.getByText("Signed in as me@example.com · pro")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.local/bin/claude")).toBeInTheDocument();
    expect(screen.getByText("Claude Code's default (~/.claude)")).toBeInTheDocument();
  });

  it("explains a signed-out Claude Code", () => {
    useSystemStore.setState({ claudeCode: status({ signedIn: false, detail: "Claude Code isn't signed in. Run claude in Terminal and sign in." }) });
    render(<ClaudeCodeSection />);
    expect(screen.getByText("Not ready")).toBeInTheDocument();
    expect(screen.getByText(/isn't signed in/)).toBeInTheDocument();
  });

  it("saves a chosen profile folder through Rust, keeping the program", async () => {
    ipc.chooseFolder.mockResolvedValue("/Users/me/.claude-profiles/Personal");
    ipc.setClaudeCode.mockResolvedValue(status({ configDir: "/Users/me/.claude-profiles/Personal" }));
    render(<ClaudeCodeSection />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: /Choose…/ })[1]));
    expect(ipc.setClaudeCode).toHaveBeenCalledWith(null, "/Users/me/.claude-profiles/Personal");
    expect(useSystemStore.getState().claudeCode?.configDir).toBe("/Users/me/.claude-profiles/Personal");
  });

  it("shows why a choice was refused", async () => {
    ipc.chooseFile.mockResolvedValue("/tmp/not-a-program");
    ipc.setClaudeCode.mockRejectedValue(new Error("/tmp/not-a-program isn't a program that can be run."));
    render(<ClaudeCodeSection />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: /Choose…/ })[0]));
    expect(screen.getByRole("alert")).toHaveTextContent("isn't a program");
  });

  it("checks again on request", async () => {
    ipc.getClaudeCodeStatus.mockResolvedValue(status({ subscription: "max" }));
    render(<ClaudeCodeSection />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Check/ })));
    expect(ipc.getClaudeCodeStatus).toHaveBeenCalled();
    expect(screen.getByText("Signed in as me@example.com · max")).toBeInTheDocument();
  });
});
