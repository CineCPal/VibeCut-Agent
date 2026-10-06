import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Broll } from "./Broll";
import { fillDrag } from "./fillDrag";
import type { PanelView } from "./usePanel";
import type { Transport } from "./transport";
import { BROLL_PANEL_VERSION, type PanelBrollFile } from "../src/types/brollPanel";

const FILE: PanelBrollFile = {
  version: BROLL_PANEL_VERSION,
  publishedAt: 1,
  indexMissing: false,
  folders: [],
  scopes: [],
  scopeLabel: "the whole archive",
  mode: "browse",
  query: "",
  shots: [
    { key: "s1", filename: "a.mov", start: 2, end: 6.5, status: "ok", caption: "a sunset" },
    { key: "s2", filename: "b.mov", start: 0, end: 3, status: "offline" },
  ],
  hasMore: false,
  total: 2,
  busy: null,
  error: null,
  pool: [],
  paths: { s1: "/Volumes/Archive/a.mov" },
  editor: { connected: true, timeline: "Main", noEditor: null, noPlace: null },
  notice: null,
};

const transport: Transport = {
  readBroll: vi.fn(),
  readThumb: vi.fn(async () => null),
  agentAliveAt: vi.fn(),
  send: vi.fn(),
  heartbeat: vi.fn(),
  fillDrag,
};

const view = (): PanelView => ({ file: FILE, agentRunning: true, pending: null, writeError: null, act: vi.fn() });

/** A DataTransfer stand-in (jsdom has none). */
function dataTransfer() {
  const data: Record<string, string> = {};
  return { data, effectAllowed: "", setData: (type: string, value: string) => (data[type] = value) };
}

describe("the Premiere B-roll panel", () => {
  it("drags a usable shot as its file through CEP's file drag", () => {
    render(<Broll file={FILE} view={view()} transport={transport} />);
    const card = screen.getByRole("group", { name: "a.mov, 0:02.0 to 0:06.5" });
    expect(card).toHaveAttribute("draggable", "true");
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.data["com.adobe.cep.dnd.file.0"]).toBe("/Volumes/Archive/a.mov");
    expect(dt.effectAllowed).toBe("copy");
    expect(screen.getByRole("group", { name: "b.mov, 0:00.0 to 0:03.0" })).toHaveAttribute("draggable", "false");
  });

  it("opens a shot in the Source monitor on a double-click, and not an offline one", () => {
    const v = view();
    render(<Broll file={FILE} view={v} transport={transport} />);
    fireEvent.doubleClick(screen.getByRole("group", { name: "a.mov, 0:02.0 to 0:06.5" }));
    expect(v.act).toHaveBeenCalledWith({ type: "broll_source", key: "s1" });
    fireEvent.doubleClick(screen.getByRole("group", { name: "b.mov, 0:00.0 to 0:03.0" }));
    expect(v.act).toHaveBeenCalledTimes(1);
  });

  it("waits for the app's connection to Premiere before Source, Import and Place", () => {
    const file = { ...FILE, editor: { connected: false, timeline: null, noEditor: "Connect first", noPlace: "Connect first" } };
    const v = { ...view(), file };
    render(<Broll file={file} view={v} transport={transport} />);
    expect(screen.getByRole("button", { name: "Place a.mov" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview a.mov in the Source monitor" })).toBeDisabled();
    fireEvent.doubleClick(screen.getByRole("group", { name: "a.mov, 0:02.0 to 0:06.5" }));
    expect(v.act).not.toHaveBeenCalled();
  });

  it("searches what's typed", () => {
    const v = view();
    render(<Broll file={FILE} view={v} transport={transport} />);
    fireEvent.change(screen.getByLabelText("Search B-roll"), { target: { value: "crowd" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(v.act).toHaveBeenCalledWith({ type: "broll_search", query: "crowd" });
  });
});
