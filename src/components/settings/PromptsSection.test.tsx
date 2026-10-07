import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PromptsSection } from "./PromptsSection";
import { usePromptStore } from "../../store/usePromptStore";

describe("Settings → Saved prompts (Phase 8h)", () => {
  beforeEach(() => usePromptStore.setState({ prompts: [{ id: "p1", name: "rough-cut", body: "Cut it." }] }));

  it("adds a prompt, saying what's wrong first", () => {
    render(<PromptsSection />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "/Rough-Cut" } });
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "Again." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("There's already a /rough-cut");
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "titles" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(usePromptStore.getState().prompts.map((p) => p.name)).toEqual(["rough-cut", "titles"]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("edits a prompt in place, and Escape leaves it as it was", () => {
    render(<PromptsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Edit /rough-cut" }));
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "Cut it tighter." } });
    fireEvent.keyDown(screen.getByLabelText(/Message/), { key: "Escape" });
    expect(usePromptStore.getState().prompts[0].body).toBe("Cut it.");
    fireEvent.click(screen.getByRole("button", { name: "Edit /rough-cut" }));
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "Cut it tighter." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(usePromptStore.getState().prompts[0].body).toBe("Cut it tighter.");
  });

  it("deletes on the second press, and restores the starters", () => {
    render(<PromptsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Delete /rough-cut" }));
    expect(usePromptStore.getState().prompts).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Press again to delete /rough-cut" }));
    expect(usePromptStore.getState().prompts).toHaveLength(0);
    expect(screen.getByText("No saved prompts.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Restore starters/ }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem").length).toBeGreaterThan(3);
  });
});
