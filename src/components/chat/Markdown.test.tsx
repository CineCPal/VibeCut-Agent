import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(async () => ({ time: 0 })), openExternal: vi.fn(async () => undefined) }));
vi.mock("../../lib/ipc", () => ipc);

import { Markdown, safeUrl } from "./Markdown";
import { emptyHostState, useNleStateStore } from "../../store/useNleStateStore";

function connectResolve(timeline: string | null = "Main") {
  useNleStateStore.setState({
    preferredHost: "auto",
    hosts: { premiere: emptyHostState("premiere"), resolve: { ...emptyHostState("resolve"), status: "connected", timeline } },
    lastTimeline: { host: "resolve", timeline: "Main", fps: 25, startTimecode: "01:00:00:00" },
  });
}

describe("Markdown (Phase 8e)", () => {
  beforeEach(() => {
    ipc.nleCall.mockClear();
    ipc.openExternal.mockClear();
    connectResolve();
  });

  it("formats lists, emphasis and tables", () => {
    render(<Markdown text={"Done:\n\n- **two** markers\n- one *cut*\n\n| Clip | Start |\n| --- | --- |\n| A | 1.0s |"} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByText("two").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Clip" })).toBeInTheDocument();
  });

  it("shows raw HTML as text and drops unsafe links", () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script>\n\nA [bad](javascript:alert(1)) and a [file](file:///etc/passwd) link'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(screen.getByText("bad")).toBeInTheDocument();
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("https://example.com")).toBe("https://example.com");
  });

  it("opens web links in the browser", () => {
    render(<Markdown text="See [the docs](https://example.com/x)." />);
    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com/x");
  });

  it("copies a code block", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"```\nffmpeg -i in.mov\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ffmpeg -i in.mov\n"));
  });

  it("moves the playhead from a t: link", async () => {
    render(<Markdown text="The laugh is at [1:23.4](t:83.4)." />);
    fireEvent.click(screen.getByRole("button", { name: "Move the playhead to 1:23.4" }));
    await waitFor(() => expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "set_playhead", { timeline: "Main", time: 83.4 }));
  });

  it("turns SMPTE timecodes into positions on the last snapshot's timeline", async () => {
    render(<Markdown text="Cut at 01:00:12:10 and `01:00:02:00`, not in ```code```." />);
    fireEvent.click(screen.getByRole("button", { name: "Move the playhead to 0:12.4" }));
    await waitFor(() => expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "set_playhead", { timeline: "Main", time: 12.4 }));
    expect(screen.getByRole("button", { name: "Move the playhead to 0:02.0" })).toBeInTheDocument();
  });

  it("leaves timecodes as text without a snapshot, and disables chips without an editor", () => {
    useNleStateStore.setState({ hosts: { premiere: emptyHostState("premiere"), resolve: emptyHostState("resolve") }, lastTimeline: null });
    render(<Markdown text="At 01:00:12:10, or [here](t:5)." />);
    expect(screen.getByText(/01:00:12:10/)).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Move the playhead to 0:05.0" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("title", expect.stringContaining("Connect"));
  });
});
