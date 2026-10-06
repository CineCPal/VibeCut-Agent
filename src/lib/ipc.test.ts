import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: tauri.getVersion }));

import * as ipc from "./ipc";

describe("ipc", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [ipc.takePendingView, "take_pending_view"],
    [ipc.getKeyStatus, "llm_key_status"],
    [ipc.getDependencyStatus, "dependency_status"],
    [ipc.getHardwareAcceleration, "hardware_acceleration"],
    [ipc.getStoragePaths, "storage_paths"],
    [ipc.getSessionStatus, "sidecar_session_status"],
    [ipc.restartSession, "sidecar_session_restart"],
    [ipc.getSidecarInfo, "sidecar_info"],
    [ipc.getNleState, "nle_state"],
    [ipc.getPremierePanelStatus, "premiere_panel_status"],
    [ipc.installPremierePanel, "premiere_panel_install"],
    [ipc.uninstallPremierePanel, "premiere_panel_uninstall"],
  ] as const)("%o invokes %s with no arguments", async (fn, command) => {
    tauri.invoke.mockResolvedValue("ok");
    await expect(fn()).resolves.toBe("ok");
    expect(tauri.invoke).toHaveBeenCalledWith(command);
  });

  it("sidecar job commands send camelCase arguments", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    await ipc.startSidecar("job-1", "health", { a: 1 });
    expect(tauri.invoke).toHaveBeenCalledWith("sidecar_start", { jobId: "job-1", command: "health", request: { a: 1 } });
    await ipc.sendToSidecar(ipc.SESSION_JOB_ID, { type: "ping" });
    expect(tauri.invoke).toHaveBeenCalledWith("sidecar_send", { jobId: "agent-session", message: { type: "ping" } });
    await ipc.cancelSidecar("job-1");
    expect(tauri.invoke).toHaveBeenCalledWith("sidecar_cancel", { jobId: "job-1" });
  });

  it.each([
    [ipc.onSidecarEvent, "sidecar-event"],
    [ipc.onSidecarExit, "sidecar-exit"],
    [ipc.onSessionStatus, "sidecar-session"],
    [ipc.onNleState, "nle-state"],
  ] as const)("%o listens to %s and unwraps the payload", async (subscribe, name) => {
    tauri.listen.mockResolvedValue(vi.fn());
    const handler = vi.fn();
    await subscribe(handler);
    expect(tauri.listen).toHaveBeenCalledWith(name, expect.any(Function));
    tauri.listen.mock.calls[0][1]({ payload: { ok: true } });
    expect(handler).toHaveBeenCalledWith({ ok: true });
  });

  it("editor calls name the host", async () => {
    tauri.invoke.mockResolvedValue({ project: "Doc" });
    await expect(ipc.nleCall("resolve", "read_timeline", { timeline: "Main" })).resolves.toEqual({ project: "Doc" });
    expect(tauri.invoke).toHaveBeenCalledWith("nle_call", { host: "resolve", command: "read_timeline", args: { timeline: "Main" } });
    await ipc.nleCall("premiere", "status");
    expect(tauri.invoke).toHaveBeenLastCalledWith("nle_call", { host: "premiere", command: "status", args: {} });
    await ipc.nleReconnect("premiere");
    expect(tauri.invoke).toHaveBeenLastCalledWith("nle_reconnect", { host: "premiere" });
  });

  it("saves and removes keys by provider, and never gets one back", async () => {
    tauri.invoke.mockResolvedValue({ gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null });
    await expect(ipc.setApiKey("gemini", "AIza-secret")).resolves.toEqual({ gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null });
    expect(tauri.invoke).toHaveBeenCalledWith("llm_key_set", { provider: "gemini", key: "AIza-secret" });
    await ipc.removeApiKey("anthropic");
    expect(tauri.invoke).toHaveBeenLastCalledWith("llm_key_remove", { provider: "anthropic" });
  });

  it("getAppVersion reads the Tauri app version", async () => {
    tauri.getVersion.mockResolvedValue("0.1.0");
    await expect(ipc.getAppVersion()).resolves.toBe("0.1.0");
  });

  it("onNavigate unwraps the event payload", async () => {
    const unlisten = vi.fn();
    tauri.listen.mockResolvedValue(unlisten);
    const handler = vi.fn();

    await expect(ipc.onNavigate(handler)).resolves.toBe(unlisten);
    expect(tauri.listen).toHaveBeenCalledWith("navigate", expect.any(Function));

    const callback = tauri.listen.mock.calls[0][1];
    callback({ event: "navigate", id: 1, payload: "broll" });
    expect(handler).toHaveBeenCalledWith("broll");
  });
});
