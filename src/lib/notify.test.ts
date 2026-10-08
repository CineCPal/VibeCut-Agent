import { beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({ isVisible: vi.fn(async () => true), isFocused: vi.fn(async () => false) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

import { enableNotifications, notificationLine, notifyAway } from "./notify";
import { useNotifyStore } from "../store/useNotifyStore";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("done notifications (Phase 11e)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    win.isVisible.mockResolvedValue(true);
    win.isFocused.mockResolvedValue(false);
    plugin.isPermissionGranted.mockResolvedValue(true);
    useNotifyStore.setState({ enabled: true, sound: false });
  });

  it("notifies only while the window is hidden or behind another app", async () => {
    notifyAway("VibeCut Agent finished", "Cut the intro.");
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "VibeCut Agent finished", body: "Cut the intro." });

    win.isFocused.mockResolvedValue(true);
    notifyAway("VibeCut Agent finished", "Again.");
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);

    win.isVisible.mockResolvedValue(false);
    notifyAway("VibeCut Agent finished", "Hidden.");
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when off or not allowed, and adds the sound when asked", async () => {
    useNotifyStore.setState({ enabled: false });
    notifyAway("t", "b");
    await flush();
    plugin.isPermissionGranted.mockResolvedValue(false);
    useNotifyStore.setState({ enabled: true });
    notifyAway("t", "b");
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    plugin.isPermissionGranted.mockResolvedValue(true);
    useNotifyStore.setState({ sound: true });
    notifyAway("t", "b");
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "t", body: "b", sound: "Glass" });
  });

  it("asks macOS the first time it's turned on", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("denied");
    expect(await enableNotifications()).toBe(false);
    plugin.requestPermission.mockResolvedValue("granted");
    expect(await enableNotifications()).toBe(true);
    expect(useNotifyStore.getState().enabled).toBe(true);
  });

  it("says the first line of a reply, without Markdown, cut short", () => {
    expect(notificationLine("\n**Cut** the [second take](t:12).\nMore.")).toBe("Cut the second take.");
    expect(notificationLine("x".repeat(200))).toHaveLength(120);
  });
});
