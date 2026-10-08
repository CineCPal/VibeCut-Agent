import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  chooseFolder: vi.fn(),
  revealInFinder: vi.fn(),
  startSidecar: vi.fn(),
  cancelSidecar: vi.fn(),
  allowPreview: vi.fn(),
  chooseSavePath: vi.fn(),
  nleCall: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://localhost${p}`, invoke: vi.fn() }));

import { FolderAnalyzer } from "./FolderAnalyzer";
import { DEFAULT_OPTIONS, runParams, useBrollStore } from "../../store/useBrollStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";

const ranked = [
  { path: "/m/b.mov", filename: "b.mov", score: 91.6, bestStart: 2, bestEnd: 6, duration: 12.4, segments: [], energy: 70, relevance: 55, duplicateOf: null },
  { path: "/m/a.mov", filename: "a.mov", score: 40, bestStart: 0, bestEnd: 4, duration: 4, segments: [], energy: null, relevance: null, duplicateOf: "/m/b.mov" },
];

/** The clip rows (each row's segment chips are list items too). */
const clipRows = () => [...screen.getByRole("list", { name: "Clips" }).children] as HTMLElement[];

const segmented = [
  { path: "/m/b.mov", filename: "b.mov", score: 91.6, bestStart: 2, bestEnd: 6, duration: 30, segments: [{ start: 2, end: 6, score: 92 }, { start: 20, end: 24, score: 80 }], energy: null, relevance: null, duplicateOf: null },
  { path: "/m/a.mxf", filename: "a.mxf", score: 40, bestStart: 0, bestEnd: 4, duration: 4, segments: [{ start: 0, end: 4, score: 40 }], energy: null, relevance: null, duplicateOf: null },
];

function keep(rankedClips: typeof segmented) {
  const s = useBrollStore.getState();
  useBrollStore.setState({ folder: "/m" });
  s.keepResult("/m", runParams({ ...useBrollStore.getState() }), { analyzed: rankedClips.length, cached: 0, cancelled: false, failed: [], warnings: [], exportPath: null, ranked: rankedClips, duplicates: 0 });
}

describe("FolderAnalyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSidecarStore.setState({ jobs: [] });
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    ipc.allowPreview.mockResolvedValue(undefined);
    useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: null, contentAware: false, brief: "", dedupe: false, query: "", analyzeJobId: null, matchJobId: null, lastResult: null, excluded: {}, preview: null });
  });

  it("starts empty and needs a folder to analyze", () => {
    render(<FolderAnalyzer />);
    expect(screen.getByText("No folder chosen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze folder" })).toBeDisabled();
  });

  it("picks a folder", async () => {
    ipc.chooseFolder.mockResolvedValue("/Volumes/Media/Broll");
    render(<FolderAnalyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(await screen.findByText("/Volumes/Media/Broll")).toBeInTheDocument();
  });

  it("shows deterministic progress with an ETA while analyzing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    useBrollStore.setState({ folder: "/m", analyzeJobId: "j" });
    useSidecarStore.getState().addJob({ id: "j", command: "broll-analyze", label: "Analyze m" }, 90_000);
    useSidecarStore.getState().applyEvent("j", { type: "progress", fraction: 0.5, phase: "analyzing", detail: "clip 3 of 6" });
    render(<FolderAnalyzer />);
    const bar = screen.getByRole("progressbar", { name: "Analyze m" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("clip 3 of 6")).toBeInTheDocument();
    expect(screen.getByText("50% · 10 s left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze folder" })).toBeDisabled();
    vi.useRealTimers();
  });

  it("lists ranked clips with their best window, scores and duplicates", () => {
    useBrollStore.setState({ folder: "/m", analyzeJobId: "j" });
    useSidecarStore.getState().addJob({ id: "j", command: "broll-analyze", label: "Analyze m" });
    useSidecarStore.getState().applyEvent("j", { type: "result", ranked, analyzed: 2, cached: 1, failed: [], warnings: ["No brief given"], duplicates: 1 });
    useSidecarStore.getState().applyExit({ jobId: "j", code: 0, cancelled: false, message: null });
    render(<FolderAnalyzer />);
    expect(screen.getByText("2 clip(s), best first · 1 from cache · 1 near-duplicate(s)")).toBeInTheDocument();
    expect(screen.getByText("No brief given")).toBeInTheDocument();
    const rows = clipRows();
    expect(rows[0]).toHaveTextContent("92");
    expect(rows[0]).toHaveTextContent("best 2.0s–6.0s of 12.4s · energy 70 · brief 55");
    expect(rows[1]).toHaveTextContent("Near-duplicate of b.mov");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Show b.mov in Finder" }));
    expect(ipc.revealInFinder).toHaveBeenCalledWith("/m/b.mov");
  });

  it("offers search only with content-aware scoring", () => {
    useBrollStore.setState({ folder: "/m" });
    const view = render(<FolderAnalyzer />);
    expect(screen.queryByLabelText("Find shots")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Content-aware scoring/ }));
    expect(screen.getByLabelText("Find shots")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    // One line in the panel; the full download disclosure is the tooltip.
    expect(screen.getByText(/first run ~2 GB/)).toBeInTheDocument();
    expect(screen.getByText("Content-aware scoring").closest("label")).toHaveAttribute("title", expect.stringContaining("installs about 2 GB"));
    view.unmount();
  });

  it("offers Place only with an editor and a timeline open", () => {
    useBrollStore.setState({ folder: "/m", analyzeJobId: "j" });
    useSidecarStore.getState().addJob({ id: "j", command: "broll-analyze", label: "Analyze m" });
    useSidecarStore.getState().applyEvent("j", { type: "result", ranked, analyzed: 2, cached: 0, failed: [], warnings: [], duplicates: 0 });
    render(<FolderAnalyzer />);
    const place = screen.getByRole("button", { name: "Place b.mov at the playhead" });
    expect(place).toBeDisabled();
    expect(place).toHaveAttribute("title", "Connect Premiere Pro or DaVinci Resolve to place clips");
  });

  it("reports a failed job", () => {
    useBrollStore.setState({ folder: "/m", analyzeJobId: "j" });
    useSidecarStore.getState().addJob({ id: "j", command: "broll-analyze", label: "Analyze m" });
    useSidecarStore.getState().fail("j", "Not a folder: /m");
    render(<FolderAnalyzer />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not a folder: /m");
  });

  it("sends the segment options it shows, and remembers them", () => {
    useBrollStore.setState({ folder: "/m" });
    ipc.startSidecar.mockResolvedValue(undefined);
    render(<FolderAnalyzer />);
    const segments = screen.getByLabelText("Segments per clip");
    fireEvent.change(segments, { target: { value: "25" } });
    fireEvent.blur(segments);
    expect(segments).toHaveValue(20);
    const length = screen.getByLabelText("Segment length");
    fireEvent.change(length, { target: { value: "2.5" } });
    fireEvent.keyDown(length, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Analyze folder" }));
    expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ windowSec: 2.5, maxSegments: 20, minGapSec: 1 });
    expect(JSON.parse(localStorage.getItem("vibecut-agent.broll") as string).state).toMatchObject({ windowSec: 2.5, maxSegments: 20 });
  });

  it("shows a kept result after a restart, with a chip per segment that ticks in and out of the selects", () => {
    keep(segmented);
    render(<FolderAnalyzer />);
    const [b] = clipRows();
    expect(within(b).getByRole("list", { name: "Segments of b.mov" })).toHaveTextContent("2.0s–6.0s· 9220.0s–24.0s· 80");
    expect(screen.getByText("Selects: 3 segments from 2 clips, 0:12")).toBeInTheDocument();
    fireEvent.click(within(b).getByRole("checkbox", { name: "Include b.mov 20.0s–24.0s in the selects" }));
    expect(screen.getByText("Selects: 2 segments from 2 clips, 0:08")).toBeInTheDocument();
    expect(useBrollStore.getState().excluded).toEqual({ "/m/b.mov": [1] });
  });

  it("dims clips the Include setting leaves out", () => {
    keep(segmented);
    render(<FolderAnalyzer />);
    fireEvent.change(screen.getByLabelText("Include"), { target: { value: "topn" } });
    const n = screen.getByLabelText("How many");
    fireEvent.change(n, { target: { value: "1" } });
    fireEvent.blur(n);
    expect(clipRows()[1]).toHaveClass("opacity-50");
    expect(screen.getByText("Selects: 2 segments from 1 clip, 0:08")).toBeInTheDocument();
  });

  it("flags a result made with other settings and re-scores it", () => {
    keep(segmented);
    ipc.startSidecar.mockResolvedValue(undefined);
    render(<FolderAnalyzer />);
    expect(screen.queryByText(/Settings changed/)).toBeNull();
    const gap = screen.getByLabelText("Gap between");
    fireEvent.change(gap, { target: { value: "3" } });
    fireEvent.blur(gap);
    expect(screen.getByText(/Settings changed since this run \(gap\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-score" }));
    expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ minGapSec: 3 });
  });

  it("previews a segment in the player, steps through the clip's segments and closes on Escape", async () => {
    keep(segmented);
    render(<FolderAnalyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Preview b.mov 20.0s–24.0s" }));
    const player = await screen.findByLabelText("b.mov, 20.0s to 24.0s");
    expect(ipc.allowPreview).toHaveBeenCalledWith("/m/b.mov");
    expect(player).toHaveAttribute("src", "asset://localhost/m/b.mov");
    const region = screen.getByRole("region", { name: "Preview of b.mov" });
    expect(region).toHaveTextContent("2/2");
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(await screen.findByLabelText("b.mov, 2.0s to 6.0s")).toBeInTheDocument();
    // Place follows the segment being previewed.
    expect(screen.getByRole("button", { name: "Place b.mov at the playhead" })).toHaveAttribute("title", "Connect Premiere Pro or DaVinci Resolve to place clips");
    fireEvent.keyDown(region, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Preview of b.mov" })).toBeNull();
  });

  it("offers the Source monitor for a format the player can't play", () => {
    keep(segmented);
    render(<FolderAnalyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Preview a.mxf 0.0s–4.0s" }));
    const region = screen.getByRole("region", { name: "Preview of a.mxf" });
    expect(region).toHaveTextContent("This format can't play here.");
    expect(ipc.allowPreview).not.toHaveBeenCalled();
    expect(within(region).getByRole("button", { name: "Open in Source monitor" })).toBeDisabled();
  });

  it("turns a player error into the Source monitor offer", async () => {
    keep(segmented);
    render(<FolderAnalyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Preview b.mov 2.0s–6.0s" }));
    fireEvent.error(await screen.findByLabelText("b.mov, 2.0s to 6.0s"));
    expect(screen.getByRole("region", { name: "Preview of b.mov" })).toHaveTextContent("its codec isn't supported");
  });

  it("explains why Build timeline is off and exports the XML", async () => {
    keep(segmented);
    ipc.chooseSavePath.mockResolvedValue("/out/sel.xml");
    ipc.startSidecar.mockImplementation(async (id: string) => {
      useSidecarStore.getState().applyEvent(id, { type: "result", exportPath: "/out/sel.xml", clips: 2, segments: 3, seconds: 12 });
      useSidecarStore.getState().applyExit({ jobId: id, code: 0, cancelled: false, message: null });
    });
    render(<FolderAnalyzer />);
    const build = screen.getByRole("button", { name: "Build timeline" });
    expect(build).toBeDisabled();
    expect(build).toHaveAttribute("title", "Connect Premiere Pro or DaVinci Resolve to build a timeline");
    fireEvent.click(screen.getByRole("button", { name: "Export XML…" }));
    expect(await screen.findByText(/Wrote 3 segments from 2 clips \(0:12\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the XML in Finder" }));
    expect(ipc.revealInFinder).toHaveBeenCalledWith("/out/sel.xml");
  });

  it("keeps the brief under Advanced, sends it, and names it on the folded heading", () => {
    useBrollStore.setState({ folder: "/m", contentAware: true });
    ipc.startSidecar.mockResolvedValue(undefined);
    render(<FolderAnalyzer />);
    const brief = screen.getByLabelText("Brief (optional)");
    expect(brief.closest("details")).toHaveTextContent("Advanced");
    fireEvent.change(brief, { target: { value: "night streets" } });
    expect(screen.getByText("Advanced").closest("summary")).toHaveTextContent("Advanced · brief: night streets");
    fireEvent.click(screen.getByRole("button", { name: "Analyze folder" }));
    expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ brief: "night streets", relevanceWeight: 0.35 });
  });

  it("hides the brief without content-aware scoring", () => {
    useBrollStore.setState({ folder: "/m", brief: "night streets" });
    render(<FolderAnalyzer />);
    expect(screen.queryByLabelText("Brief (optional)")).toBeNull();
    expect(screen.getByText("Advanced").closest("summary")).toHaveTextContent(/^Advanced$/);
  });

  it("lists the segment fields, then content-aware scoring, then Advanced", () => {
    useBrollStore.setState({ folder: "/m" });
    render(<FolderAnalyzer />);
    const options = screen.getByRole("region", { name: "Options" });
    const text = options.textContent ?? "";
    expect(text.indexOf("Segments per clip")).toBeLessThan(text.indexOf("Content-aware scoring"));
    expect(text.indexOf("Content-aware scoring")).toBeLessThan(text.indexOf("Advanced"));
  });
});
