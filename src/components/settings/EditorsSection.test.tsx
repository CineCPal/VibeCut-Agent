import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PremierePanelStatus, ResolvePluginStatus } from "../../types/nle";
import { nleState } from "../../test/nleFixtures";

const ipc = vi.hoisted(() => ({
  getPremierePanelStatus: vi.fn(),
  installPremierePanel: vi.fn(),
  uninstallPremierePanel: vi.fn(),
  getResolvePluginStatus: vi.fn(),
  installResolvePlugin: vi.fn(),
  uninstallResolvePlugin: vi.fn(),
  nleReconnect: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

import { EditorsSection } from "./EditorsSection";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";

const panel = (over: Partial<PremierePanelStatus> = {}): PremierePanelStatus => ({
  premiereInstalled: true,
  bundledVersion: "0.1.0",
  installedVersion: null,
  installedPath: "/Users/me/Library/Application Support/Adobe/CEP/extensions/com.vibecutagent.connect",
  debugMode: true,
  running: false,
  ...over,
});

const plugin = (over: Partial<ResolvePluginStatus> = {}): ResolvePluginStatus => ({
  resolveInstalled: true,
  bundledVersion: "0.19.0",
  installedVersion: null,
  installedPath: "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.vibecutagent.resolve",
  running: false,
  ...over,
});

describe("EditorsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hosts = initialHosts();
    hosts.premiere = nleState("premiere", { status: "disconnected", message: "Install it from Settings > Editors" });
    hosts.resolve = nleState("resolve", { status: "unavailable", message: "DaVinci Resolve 21.1 or later isn't installed." });
    useNleStateStore.setState({ hosts });
    ipc.getPremierePanelStatus.mockResolvedValue(panel());
    ipc.getResolvePluginStatus.mockResolvedValue(plugin());
  });

  it("shows each editor's state, leaving the reason to About", async () => {
    render(<EditorsSection />);
    await act(async () => undefined);
    expect(screen.queryByText("Install it from Settings > Editors")).not.toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect DaVinci Resolve" })).toBeDisabled();
  });

  it("installs the panel only when asked, then shows what to do next", async () => {
    ipc.installPremierePanel.mockResolvedValue(panel({ installedVersion: "0.1.0" }));
    render(<EditorsSection />);
    await act(async () => undefined);
    expect(screen.getByText(/^Install the panel/)).toBeInTheDocument();
    expect(ipc.installPremierePanel).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Install panel" })));
    expect(ipc.installPremierePanel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText(/^Installed\. Start or restart Premiere Pro/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update panel" })).toBeDisabled();
  });

  it("reconnects a host and reports failures", async () => {
    ipc.nleReconnect.mockRejectedValue(new Error("uv not found"));
    render(<EditorsSection />);
    await act(async () => undefined);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconnect Premiere Pro" })));
    expect(ipc.nleReconnect).toHaveBeenCalledWith("premiere");
    expect(screen.getByRole("alert")).toHaveTextContent("uv not found");
  });

  it("installs the Resolve plugin only when asked, and says where to open it", async () => {
    ipc.installResolvePlugin.mockResolvedValue(plugin({ installedVersion: "0.19.0" }));
    render(<EditorsSection />);
    await act(async () => undefined);
    expect(screen.getByText("DaVinci Resolve plugin")).toBeInTheDocument();
    expect(ipc.installResolvePlugin).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Install plugin" })));
    expect(ipc.installResolvePlugin).toHaveBeenCalledTimes(1);
    expect(ipc.installPremierePanel).not.toHaveBeenCalled();
    expect(screen.getByText(/^Installed\. After installing or updating, restart DaVinci Resolve and open Workspace → Workflow Integrations → VibeCut Agent\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update plugin" })).toBeDisabled();
  });

  it("offers an update for an older plugin, and uninstalls it", async () => {
    ipc.getResolvePluginStatus.mockResolvedValue(plugin({ installedVersion: "0.18.0" }));
    ipc.uninstallResolvePlugin.mockResolvedValue(plugin());
    render(<EditorsSection />);
    await act(async () => undefined);
    expect(screen.getByText(/^Update the plugin \(installed 0\.18\.0, this app has 0\.19\.0\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update plugin" })).toBeEnabled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Uninstall the DaVinci Resolve plugin" })));
    expect(ipc.uninstallResolvePlugin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Install plugin" })).toBeInTheDocument();
  });
});
