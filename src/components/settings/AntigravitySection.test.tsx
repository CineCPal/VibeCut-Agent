import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  chooseFile: vi.fn(),
  setAntigravity: vi.fn(),
  addAntigravityTools: vi.fn(),
  removeAntigravityTools: vi.fn(),
  getAntigravityStatus: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

import { AntigravitySection } from "./AntigravitySection";
import { useSystemStore } from "../../store/useSystemStore";
import type { AntigravityStatus } from "../../types/agent";

const status = (over: Partial<AntigravityStatus> = {}): AntigravityStatus => ({
  program: "/Users/me/.local/bin/agy",
  programSaved: null,
  signedIn: true,
  models: ["gemini-4-argon", "gemini-3.8-flash"],
  toolsAdded: true,
  toolsCurrent: true,
  detail: null,
  ...over,
});

describe("AntigravitySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStore.setState({ antigravity: status() });
  });

  it("shows it's signed in, where agy runs from and the plan's Gemini models", () => {
    render(<AntigravitySection />);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.local/bin/agy")).toBeInTheDocument();
    expect(screen.getByText("Gemini 4 Argon, Gemini 3.8 Flash")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });

  it("adds VibeCut's tools only when asked", async () => {
    useSystemStore.setState({ antigravity: status({ toolsAdded: false, toolsCurrent: false, detail: "VibeCut's tools aren't added to Antigravity yet." }) });
    ipc.addAntigravityTools.mockResolvedValue(status());
    render(<AntigravitySection />);
    expect(screen.getByText("Signed in, not ready yet")).toBeInTheDocument();
    expect(ipc.addAntigravityTools).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(ipc.addAntigravityTools).toHaveBeenCalledTimes(1);
    expect(useSystemStore.getState().antigravity?.toolsCurrent).toBe(true);
  });

  it("offers to update an older copy, or remove it", async () => {
    useSystemStore.setState({ antigravity: status({ toolsCurrent: false }) });
    ipc.removeAntigravityTools.mockResolvedValue(status({ toolsAdded: false, toolsCurrent: false }));
    render(<AntigravitySection />);
    expect(screen.getByText("An older copy: update them")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(ipc.removeAntigravityTools).toHaveBeenCalledTimes(1);
    expect(useSystemStore.getState().antigravity?.toolsAdded).toBe(false);
  });

  it("says when agy is signed out, and saves a chosen program", async () => {
    useSystemStore.setState({ antigravity: status({ signedIn: false, models: [], detail: "Antigravity isn't signed in. Run agy in Terminal and sign in." }) });
    ipc.chooseFile.mockResolvedValue("/opt/agy");
    ipc.setAntigravity.mockResolvedValue(status({ program: "/opt/agy", programSaved: "/opt/agy" }));
    render(<AntigravitySection />);
    expect(screen.getByText("Not ready")).toBeInTheDocument();
    expect(screen.getByText(/isn't signed in/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose…" })));
    expect(ipc.setAntigravity).toHaveBeenCalledWith("/opt/agy");
    expect(useSystemStore.getState().antigravity?.programSaved).toBe("/opt/agy");
  });

  it("shows a failed add", async () => {
    useSystemStore.setState({ antigravity: status({ toolsAdded: false, toolsCurrent: false }) });
    ipc.addAntigravityTools.mockRejectedValue(new Error("agy mcp add didn't work: boom"));
    render(<AntigravitySection />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(screen.getByRole("alert")).toHaveTextContent("agy mcp add didn't work: boom");
  });
});
