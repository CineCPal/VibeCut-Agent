import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useHotkeys, viewForShortcut } from "./useHotkeys";
import { useUiStore } from "../store/useUiStore";

function Harness() {
  useHotkeys();
  return null;
}

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("useHotkeys", () => {
  beforeEach(() => useUiStore.setState({ tab: "chat", overlay: null }));

  it("maps ⌘/Ctrl shortcuts to views", () => {
    expect(viewForShortcut(key("1", { metaKey: true }))).toBe("chat");
    expect(viewForShortcut(key("2", { ctrlKey: true }))).toBe("broll");
    expect(viewForShortcut(key(",", { metaKey: true }))).toBe("settings");
    expect(viewForShortcut(key("I", { metaKey: true }))).toBe("about");
  });

  it("ignores unmodified or extra-modified keys", () => {
    expect(viewForShortcut(key("1"))).toBeNull();
    expect(viewForShortcut(key("1", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(viewForShortcut(key("x", { metaKey: true }))).toBeNull();
  });

  it("navigates on keydown", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(useUiStore.getState().tab).toBe("broll");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(useUiStore.getState().overlay).toBe("settings");
  });
});
