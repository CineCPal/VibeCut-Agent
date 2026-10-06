import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./useUiStore";

describe("useUiStore", () => {
  beforeEach(() => useUiStore.setState({ tab: "chat", overlay: null }));

  it("navigates to tabs and closes any overlay", () => {
    useUiStore.setState({ overlay: "about" });
    useUiStore.getState().navigate("broll");
    expect(useUiStore.getState()).toMatchObject({ tab: "broll", overlay: null });
  });

  it("opens settings and about over the current tab", () => {
    useUiStore.getState().setTab("broll");
    useUiStore.getState().navigate("settings");
    expect(useUiStore.getState()).toMatchObject({ tab: "broll", overlay: "settings" });
    useUiStore.getState().navigate("about");
    expect(useUiStore.getState().overlay).toBe("about");
    useUiStore.getState().closeOverlay();
    expect(useUiStore.getState().overlay).toBeNull();
  });
});
