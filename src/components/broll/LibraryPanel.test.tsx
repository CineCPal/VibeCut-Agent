import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const lib = vi.hoisted(() => ({
  openLibrary: vi.fn(),
  searchLibrary: vi.fn(),
  browseMore: vi.fn(),
  clearScope: vi.fn(),
  setScope: vi.fn(),
  toggleFolder: vi.fn(),
  changePool: vi.fn(),
  importShots: vi.fn(),
  previewShot: vi.fn(),
  placeShot: vi.fn(),
  dragShot: vi.fn(),
  connectedHost: vi.fn(),
  placeBlocked: vi.fn(),
}));
vi.mock("../../lib/library", async (original) => ({ ...(await original<typeof import("../../lib/library")>()), ...lib }));
vi.mock("../../lib/spyglassIpc", () => ({ keyframeUrl: (p: string) => `asset://localhost${p}` }));

import { BrollPanel } from "./BrollPanel";
import { useLibraryStore, type LibraryShot } from "../../store/useLibraryStore";
import { useUiStore } from "../../store/useUiStore";

const shot = (key: string, over: Partial<LibraryShot> = {}): LibraryShot => ({
  key,
  shotId: Number(key.slice(1)),
  path: `/Volumes/Archive/${key}.mov`,
  filename: `${key}.mov`,
  start: 2,
  end: 6.5,
  caption: "players on a field",
  tags: [],
  technical: 81,
  energy: null,
  status: "ok",
  keyframe: `/kf/${key}.jpg`,
  ...over,
});

describe("the B-roll Library panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    lib.connectedHost.mockReturnValue("premiere");
    lib.placeBlocked.mockReturnValue(null);
    useLibraryStore.setState({
      view: "library",
      index: { path: "/suite/spyglass_index.sqlite", source: "environment", chosen: null },
      scopes: [],
      expanded: [],
      children: {},
      mode: "browse",
      query: "",
      results: [shot("s1"), shot("s2", { status: "offline" })],
      total: 2,
      hasMore: false,
      busy: null,
      error: null,
      warnings: [],
      searchJobId: null,
      pool: [],
      notice: null,
      pending: [],
    });
  });

  it("opens the Library by default, and switches to the folder analyzer", () => {
    render(<BrollPanel />);
    expect(lib.openLibrary).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("2 shot(s) in the whole archive");
    fireEvent.click(screen.getByRole("tab", { name: "Folder" }));
    expect(useLibraryStore.getState().view).toBe("folder");
    expect(screen.getByRole("button", { name: "Analyze folder" })).toBeInTheDocument();
  });

  it("shows keyframes and previews a shot when its thumbnail is double-clicked", () => {
    render(<BrollPanel />);
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "asset://localhost/kf/s1.jpg");
    fireEvent.doubleClick(screen.getAllByRole("img")[0]);
    expect(lib.previewShot).toHaveBeenCalledWith("s1");
  });

  it("lets an offline shot say which drive to attach, instead of doing nothing", () => {
    render(<BrollPanel />);
    fireEvent.doubleClick(screen.getAllByRole("img")[1]);
    expect(lib.previewShot).toHaveBeenCalledWith("s2");
    expect(screen.getByRole("button", { name: "Place s2.mov" })).toBeDisabled();
    expect(screen.getByText(/1 of 2 shot\(s\) here are on a drive that isn't attached: Archive/)).toBeInTheDocument();
  });

  it("starts a native drag of the shot's file instead of the webview's", () => {
    render(<BrollPanel />);
    const card = screen.getByRole("listitem", { name: "s1.mov, 0:02.0 to 0:06.5" });
    expect(card).toHaveAttribute("draggable", "true");
    const allowed = fireEvent.dragStart(card);
    expect(allowed).toBe(false);
    expect(lib.dragShot).toHaveBeenCalledWith(expect.objectContaining({ key: "s1" }));
    // Offline shots stay draggable, so the drag can say which drive to attach.
    expect(screen.getByRole("listitem", { name: "s2.mov, 0:02.0 to 0:06.5" })).toHaveAttribute("draggable", "true");
  });

  it("takes VibeCut's keys on a focused card", () => {
    render(<BrollPanel />);
    const card = screen.getByRole("listitem", { name: "s1.mov, 0:02.0 to 0:06.5" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "p" });
    fireEvent.keyDown(card, { key: "i" });
    fireEvent.keyDown(card, { key: "a" });
    expect(lib.previewShot).toHaveBeenCalledWith("s1");
    expect(lib.placeShot).toHaveBeenCalledWith("s1");
    expect(lib.importShots).toHaveBeenCalledWith(["s1"]);
    expect(lib.changePool).toHaveBeenCalledWith("add", ["s1"]);
  });

  it("says why the editor actions are off", () => {
    lib.connectedHost.mockReturnValue(null);
    lib.placeBlocked.mockReturnValue("Connect Premiere Pro or DaVinci Resolve to place clips");
    render(<BrollPanel />);
    expect(screen.getByRole("button", { name: "Preview s1.mov in the Source monitor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import s1.mov" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Source, Import and Place: connect premiere pro or davinci resolve first");
  });

  it("searches what's typed, or browses when it's empty", () => {
    render(<BrollPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(lib.searchLibrary).toHaveBeenLastCalledWith("");
    fireEvent.change(screen.getByLabelText("Search B-roll"), { target: { value: "sunset" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(lib.searchLibrary).toHaveBeenLastCalledWith("sunset");
  });

  it("points to Settings when there's no index", () => {
    useLibraryStore.setState({ index: null });
    render(<BrollPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Choose index in Settings…" }));
    expect(useUiStore.getState().overlay).toBe("settings");
  });

  it("shows the pool with its own actions", () => {
    useLibraryStore.setState({ pool: [shot("s1")] });
    render(<BrollPanel />);
    expect(screen.getByRole("button", { name: "Pool s1.mov" })).toHaveTextContent("Pooled");
    expect(screen.getByRole("button", { name: "Pool s1.mov" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    expect(lib.importShots).toHaveBeenCalledWith(["s1"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove s1.mov from the pool" }));
    expect(lib.changePool).toHaveBeenCalledWith("remove", ["s1"]);
  });
});
