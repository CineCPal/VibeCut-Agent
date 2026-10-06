import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  getKeyStatus: vi.fn(),
  getDependencyStatus: vi.fn(),
  getHardwareAcceleration: vi.fn(),
  getStoragePaths: vi.fn(),
  getSidecarInfo: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);

import { useSystemStore } from "./useSystemStore";

describe("useSystemStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStore.setState({ keys: null, dependencies: [], hwAccel: null, storage: null, sidecar: null, loading: false, error: null, checkedAt: null });
  });

  it("refresh loads every status in parallel", async () => {
    ipc.getKeyStatus.mockResolvedValue({ gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null });
    ipc.getDependencyStatus.mockResolvedValue([{ name: "ffmpeg", path: "/opt/homebrew/bin/ffmpeg", version: "7.1" }]);
    ipc.getHardwareAcceleration.mockResolvedValue({ videotoolbox: true, nvenc: false });
    ipc.getStoragePaths.mockResolvedValue({ config: "/c", data: "/d", logs: "/l" });
    ipc.getSidecarInfo.mockResolvedValue({ uvPath: "/uv", pythonRoot: "/repo", installed: true, environment: null });

    await useSystemStore.getState().refresh();

    expect(useSystemStore.getState()).toMatchObject({
      keys: { gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null },
      dependencies: [{ name: "ffmpeg", version: "7.1" }],
      hwAccel: { videotoolbox: true },
      storage: { config: "/c" },
      sidecar: { pythonRoot: "/repo", installed: true },
      loading: false,
      error: null,
    });
    expect(useSystemStore.getState().checkedAt).not.toBeNull();
  });

  it("refresh records an error and keeps previous values", async () => {
    useSystemStore.setState({ keys: { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null } });
    ipc.getKeyStatus.mockRejectedValue(new Error("IPC unavailable"));
    ipc.getDependencyStatus.mockResolvedValue([]);
    ipc.getHardwareAcceleration.mockResolvedValue({ videotoolbox: false, nvenc: false });
    ipc.getStoragePaths.mockResolvedValue({ config: null, data: null, logs: null });
    ipc.getSidecarInfo.mockResolvedValue({ uvPath: "uv", pythonRoot: "/r", installed: false, environment: null });

    await useSystemStore.getState().refresh();

    expect(useSystemStore.getState()).toMatchObject({ loading: false, error: "IPC unavailable", keys: { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null } });
  });

  it("ignores a refresh while one is running", async () => {
    useSystemStore.setState({ loading: true });
    await useSystemStore.getState().refresh();
    expect(ipc.getKeyStatus).not.toHaveBeenCalled();
  });
});
