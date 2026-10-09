import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn().mockResolvedValue(null)]));
});

import { SettingsPanel } from "./SettingsPanel";
import { useUiStore } from "../../store/useUiStore";
import { useAgentStore } from "../../store/useAgentStore";
import { useSystemStore } from "../../store/useSystemStore";

describe("SettingsPanel", () => {
  beforeEach(() => {
    useUiStore.setState({ settingsTab: "agent" });
  });

  const renderPanel = async () => {
    render(<SettingsPanel onClose={() => undefined} />);
    await act(async () => undefined);
  };

  it("groups settings into tabs, opening on the last one shown", async () => {
    await renderPanel();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["General", "Agent", "Accounts", "Editors", "Library"]);
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Agent model" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Saved prompts" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Review edits before they’re made/ })).not.toBeChecked();
    expect(screen.queryByRole("heading", { name: "API keys" })).not.toBeInTheDocument();
  });

  it("switches tabs by click and arrow keys, and remembers the tab", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Accounts" }));
    expect(screen.getByRole("heading", { name: "API keys" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claude subscription" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Accounts" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Editors" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Preferred editor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Outside control" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Editors" }), { key: "Home" });
    expect(screen.getByRole("heading", { name: "Window" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Notify when the agent finishes or needs you/ })).toBeChecked();
    expect(useUiStore.getState().settingsTab).toBe("general");
  });

  it("leaves what About already shows to About", async () => {
    await renderPanel();
    for (const tab of ["General", "Agent", "Accounts", "Editors", "Library"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await act(async () => undefined);
      expect(screen.queryByRole("heading", { name: "Agent sidecar" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Local dependencies" })).not.toBeInTheDocument();
    }
  });

  it("picks the edit review critic, Gemini Flash by default", async () => {
    useAgentStore.setState({ criticModel: "gemini" });
    useSystemStore.setState({ keys: { gemini: false, anthropic: true } as never });
    await renderPanel();
    const critic = screen.getByRole("combobox", { name: "Edit review critic" }) as HTMLSelectElement;
    expect(critic.value).toBe("gemini");
    expect(screen.getByRole("option", { name: /Gemini Flash \(default\) — key missing, uses the agent's model/ })).toBeInTheDocument();
    fireEvent.change(critic, { target: { value: "same" } });
    expect(useAgentStore.getState().criticModel).toBe("same");
  });
});
