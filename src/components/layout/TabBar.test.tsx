import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";
import { useUiStore } from "../../store/useUiStore";

describe("TabBar", () => {
  beforeEach(() => useUiStore.setState({ tab: "chat", overlay: null }));

  it("puts Agent, Library and Analyze in one row, with their shortcuts", () => {
    render(<TabBar />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Agent", "Library", "Analyze"]);
    expect(tabs[1]).toHaveAttribute("title", "Search and browse Spyglass's index of your archive (⌘2)");
    expect(tabs[2]).toHaveAttribute("title", expect.stringContaining("(⌘3)"));
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("switches by click and by arrow keys", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(useUiStore.getState().tab).toBe("library");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Library" }), { key: "ArrowRight" });
    expect(useUiStore.getState().tab).toBe("broll");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Analyze" }), { key: "ArrowRight" });
    expect(useUiStore.getState().tab).toBe("chat");
  });
});
