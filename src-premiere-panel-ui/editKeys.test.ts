import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEditKey, installEditKeys, KEY_INTEREST, type Clipboard } from "./editKeys";

const key = (k: string, over: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key: k, metaKey: true, cancelable: true, ...over });

function field(value: string, start: number, end = start) {
  const input = document.createElement("textarea");
  document.body.appendChild(input);
  input.value = value;
  input.focus();
  input.setSelectionRange(start, end);
  return input;
}

describe("copy, paste and undo in Premiere's panels", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("asks CEP for ⌘A, ⌘Z, ⌘X, ⌘C, ⌘V and ⇧⌘Z", () => {
    const registerKeyEventsInterest = vi.fn();
    const win = { __adobe_cep__: { registerKeyEventsInterest }, document } as unknown as Window;
    const undo = installEditKeys({ read: () => "", write: () => undefined }, win);
    expect(JSON.parse(registerKeyEventsInterest.mock.calls[0][0])).toEqual(KEY_INTEREST);
    expect(KEY_INTEREST).toContainEqual({ keyCode: 6, metaKey: true, shiftKey: true });
    undo();
  });

  it("copies the field's selection, cuts it, and pastes from the pasteboard through the editing commands", () => {
    const clipboard: Clipboard = { read: vi.fn(() => "pasted"), write: vi.fn() };
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    field("tighten the intro", 0, 7);

    const copy = key("c");
    expect(handleEditKey(copy, clipboard)).toBe(true);
    expect(clipboard.write).toHaveBeenCalledWith("tighten");
    expect(copy.defaultPrevented).toBe(true);

    expect(handleEditKey(key("x"), clipboard)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("delete", false, undefined);

    expect(handleEditKey(key("v"), clipboard)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("insertText", false, "pasted");

    expect(handleEditKey(key("z"), clipboard)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("undo", false, undefined);
    expect(handleEditKey(key("z", { shiftKey: true }), clipboard)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("redo", false, undefined);
  });

  it("selects all in a field, and leaves other keys and plain typing alone", () => {
    const clipboard: Clipboard = { read: () => "", write: vi.fn() };
    const input = field("abc", 1);
    expect(handleEditKey(key("a"), clipboard)).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    expect(handleEditKey(key("k"), clipboard)).toBe(false);
    expect(handleEditKey(key("v", { metaKey: false }), clipboard)).toBe(false);
  });

  it("doesn't paste or undo outside a text field", () => {
    const clipboard: Clipboard = { read: vi.fn(() => "x"), write: vi.fn() };
    expect(handleEditKey(key("v"), clipboard)).toBe(false);
    expect(handleEditKey(key("z"), clipboard)).toBe(false);
    expect(clipboard.read).not.toHaveBeenCalled();
  });
});
