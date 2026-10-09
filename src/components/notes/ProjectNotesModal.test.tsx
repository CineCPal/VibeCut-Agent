import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));

import { ProjectNotesModal } from "./ProjectNotesModal";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";

describe("ProjectNotesModal", () => {
  let stored = "";
  beforeEach(() => {
    stored = "## Brief\n- Bakery film\n";
    core.invoke.mockReset();
    core.invoke.mockImplementation(async (cmd: string, args: { text?: string }) => {
      if (cmd === "project_notes_get") return stored;
      if (cmd === "project_notes_set") stored = args.text!;
    });
    const hosts = initialHosts();
    hosts.premiere = { ...hosts.premiere, status: "connected", project: "Bakery" };
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
  });

  it("shows the open project's notes, saves with ⌘S and on close", async () => {
    const onClose = vi.fn();
    render(<ProjectNotesModal onClose={onClose} />);
    const box = await screen.findByRole("textbox", { name: "Notes for Bakery" });
    await waitFor(() => expect(box).toHaveValue("## Brief\n- Bakery film\n"));
    fireEvent.change(box, { target: { value: "## Brief\n- Bakery film, 60 s\n" } });
    expect(screen.getByRole("status")).toHaveTextContent("Not saved yet");
    fireEvent.keyDown(box, { key: "s", metaKey: true });
    await waitFor(() => expect(stored).toBe("## Brief\n- Bakery film, 60 s\n"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    fireEvent.change(box, { target: { value: "cleared" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(stored).toBe("cleared");
  });

  it("says to open a project when none is", () => {
    useNleStateStore.setState({ hosts: initialHosts() });
    render(<ProjectNotesModal onClose={() => undefined} />);
    expect(screen.getByText(/Open a project in Premiere Pro or DaVinci Resolve/)).toBeInTheDocument();
  });
});
