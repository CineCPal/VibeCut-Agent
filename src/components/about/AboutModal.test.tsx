import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({ getAppVersion: vi.fn().mockResolvedValue("0.1.0") }));

import { AboutModal } from "./AboutModal";
import { useSystemStore } from "../../store/useSystemStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { AGENT_OFFLINE_DETAIL, useAgentStore } from "../../store/useAgentStore";
import { useSidecarStore } from "../../store/useSidecarStore";

describe("AboutModal", () => {
  beforeEach(() => {
    useSystemStore.setState({
      keys: { gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null },
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
    expect(within(screen.getByText("Active model: Gemini").closest("li")!).getByText("Key configured")).toBeInTheDocument();
    expect(within(screen.getByText("Agent sidecar").closest("li")!).getByText("Running · Python 3.14.0")).toBeInTheDocument();
    // AGENTS.md §4: every network endpoint the app can reach is disclosed.
    for (const host of ["generativelanguage.googleapis.com", "api.anthropic.com", "huggingface.co"]) {
      expect(screen.getByText(new RegExp(`^${host.replace(/\./g, "\\.")}`))).toBeInTheDocument();
    }
    // Phase 7b: the subscription path and its MCP bridge are disclosed too.
    expect(screen.getByText(/^Your own Claude Code .* calls api\.anthropic\.com .* MCP bridge \(files, no network port\)$/)).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<AboutModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
