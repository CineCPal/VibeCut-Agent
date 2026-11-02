import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getAppVersion: vi.fn().mockResolvedValue("0.1.0"), restartSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../../lib/jobs", () => jobs);

import { AboutModal } from "./AboutModal";
import { useSystemStore } from "../../store/useSystemStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { AGENT_OFFLINE_DETAIL, useAgentStore } from "../../store/useAgentStore";
import { useSidecarStore } from "../../store/useSidecarStore";

const health = (result: Record<string, unknown>) => ({
  status: "done",
  result: { localLlmBaseUrl: "http://127.0.0.1:11434", indexDir: "/data/vector-index", ...result },
});

describe("AboutModal", () => {
  beforeEach(() => {
    useSystemStore.setState({
      keys: { gemini: true, geminiSource: "keychain", huggingface: false, huggingfaceSource: null },
      dependencies: [
        { name: "ffmpeg", path: "/opt/homebrew/bin/ffmpeg", version: "7.1" },
        { name: "exiftool", path: null, version: null },
      ],
      hwAccel: { videotoolbox: true, nvenc: false },
      storage: { config: "/Users/me/Library/Application Support/com.cj.vibecutagent", data: "/data", logs: "/logs", history: "/data/history" },
      sidecar: { uvPath: "/opt/homebrew/bin/uv", pythonRoot: "/repo", installed: true, environment: null },
      loading: false,
      error: null,
    });
    const hosts = initialHosts();
    hosts.resolve.status = "connected";
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useAgentStore.setState({ aiChoice: "gemini", status: "offline", statusDetail: AGENT_OFFLINE_DETAIL });
    useSidecarStore.setState({ session: { state: "ready", version: "0.1.0", python: "3.14.0", message: null } });
    jobs.runJob.mockResolvedValue(health({ executionMode: "direct", workers: [] }));
  });

  it("is a labelled modal dialog", () => {
    render(<AboutModal onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "About This App" })).toHaveAttribute("aria-modal", "true");
  });

  it("shows version, binaries, acceleration, storage and connection status", async () => {
    render(<AboutModal onClose={() => undefined} />);
    expect(await screen.findByText("Version 0.1.0")).toBeInTheDocument();
    expect(screen.getByText("/opt/homebrew/bin/ffmpeg")).toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(within(screen.getByText("VideoToolbox (Apple)").closest("li")!).getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("/data")).toBeInTheDocument();
    expect(screen.getByText("/data/history")).toBeInTheDocument();
    expect(screen.getByText("/repo/.venv")).toBeInTheDocument();
    expect(within(screen.getByText("DaVinci Resolve").closest("li")!).getByText("Connected")).toBeInTheDocument();
    expect(within(screen.getByText("Active model: Gemini 3.8 Flash").closest("li")!).getByText("Key configured")).toBeInTheDocument();
    expect(within(screen.getByText("Agent sidecar").closest("li")!).getByText("Running · Python 3.14.0")).toBeInTheDocument();
    // AGENTS.md §4: every network endpoint the app can reach is disclosed.
    for (const host of ["generativelanguage.googleapis.com", "huggingface.co"]) {
      expect(screen.getByText(new RegExp(`^${host.replace(/\./g, "\\.")}`))).toBeInTheDocument();
    }
    // Phase 7b: the subscription path (Claude's only one since model migration v2) and its MCP bridge.
    expect(screen.getByText(/^Your own Claude Code .* calls api\.anthropic\.com .* MCP bridge \(files, no network port\)$/)).toBeInTheDocument();
    // Model migration v2: the local model server is disclosed, and the removed providers are gone.
    expect(within(screen.getByText("Local models").closest("li")!).getByText("On this Mac")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic API")).toBeNull();
    expect(screen.queryByText(/Antigravity/)).toBeNull();
  });

  it("restarts the sidecar and refreshes the binaries (moved here from Settings)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useSystemStore.setState({ refresh });
    render(<AboutModal onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart the agent sidecar" }));
    expect(ipc.restartSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Version 0.1.0")).toBeInTheDocument();
  });

  it("says the chat runs in direct mode, with no local sub-agents", async () => {
    render(<AboutModal onClose={() => undefined} />);
    const row = (await screen.findByText("Direct")).closest("li")!;
    expect(within(row).getByText("Execution mode")).toBeInTheDocument();
    expect(within(row).getByText(/no local sub-agents run$/)).toBeInTheDocument();
    expect(jobs.runJob).toHaveBeenCalledWith("orchestrator-health", "Check the local sub-agents", {});
    expect(screen.queryByText("Speech (Whisper)")).not.toBeInTheDocument();
  });

  it("shows each local sub-agent's health in orchestrated mode", async () => {
    jobs.runJob.mockResolvedValue(
      health({
        executionMode: "orchestrated",
        workers: [
          { worker: "whisper", backend: "mlx-whisper", model: "mlx-community/whisper-medium-mlx", available: true, detail: "ready" },
          { worker: "gemma", backend: "ollama", model: "gemma3:4b-it", available: false, detail: "missing; deltas are still checked, without the model's notes" },
        ],
      }),
    );
    render(<AboutModal onClose={() => undefined} />);
    expect(await screen.findByText("Orchestrated")).toBeInTheDocument();
    // AGENTS.md §4: the local model server is disclosed as on this Mac.
    expect(screen.getByText(/local models at http:\/\/127\.0\.0\.1:11434 \(Ollama or llama\.cpp, on this Mac\)/)).toBeInTheDocument();
    expect(within(screen.getByText("Speech (Whisper)").closest("li")!).getByText("Ready")).toBeInTheDocument();
    const gemma = screen.getByText("Edit validator (Gemma)").closest("li")!;
    expect(within(gemma).getByText("Unavailable")).toBeInTheDocument();
    expect(within(gemma).getByText("ollama · gemma3:4b-it · missing; deltas are still checked, without the model's notes")).toBeInTheDocument();
  });

  it("says when the mode couldn't be read", async () => {
    jobs.runJob.mockResolvedValue({ status: "failed", result: null });
    render(<AboutModal onClose={() => undefined} />);
    const row = (await screen.findByText(/^Set by EXECUTION_MODE/)).closest("li")!;
    expect(await within(row).findByText("Unknown")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<AboutModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
