import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ chooseFolder: vi.fn(), revealInFinder: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { FolderAnalyzer } from "./FolderAnalyzer";
import { useBrollStore } from "../../store/useBrollStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";

const ranked = [
  { path: "/m/b.mov", filename: "b.mov", score: 91.6, bestStart: 2, bestEnd: 6, duration: 12.4, segments: [], energy: 70, relevance: 55, duplicateOf: null },
  { path: "/m/a.mov", filename: "a.mov", score: 40, bestStart: 0, bestEnd: 4, duration: 4, segments: [], energy: null, relevance: null, duplicateOf: "/m/b.mov" },
];

describe("FolderAnalyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSidecarStore.setState({ jobs: [] });
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    useBrollStore.setState({ folder: null, contentAware: false, brief: "", dedupe: false, query: "", analyzeJobId: null, matchJobId: null });
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
    const rows = within(screen.getByRole("list", { name: "Clips" })).getAllByRole("listitem");
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
    expect(screen.getByText(/installs about 2 GB/)).toBeInTheDocument();
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
});
