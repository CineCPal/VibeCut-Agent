/**
 * Copy, cut, paste, undo, redo and select all in Premiere's CEP panels. Premiere keeps ⌘C, ⌘X, ⌘V, ⌘Z,
 * ⇧⌘Z and ⌘A for its own Edit menu, so a panel's text fields never see them. The panel asks CEP for those
 * keys (`registerKeyEventsInterest`), then does each edit itself: through `document.execCommand`, so a
 * paste lands on the field's own undo history and React sees the change, with the Mac's pasteboard read
 * and written through `pbpaste` / `pbcopy` (CEP's Chromium has no clipboard permission to give).
 */

export interface Clipboard {
  read(): string;
  write(text: string): void;
}

/** CEP's native object; `registerKeyEventsInterest` takes a JSON list of keys. */
interface AdobeCep {
  registerKeyEventsInterest?: (keys: string) => void;
}

/** macOS virtual key codes: A, Z, X, C, V. */
const KEYS = { a: 0, z: 6, x: 7, c: 8, v: 9 } as const;

/** The keys the panel takes from Premiere: each with ⌘, and ⇧⌘Z for redo. */
export const KEY_INTEREST = [
  ...Object.values(KEYS).map((keyCode) => ({ keyCode, metaKey: true })),
  { keyCode: KEYS.z, metaKey: true, shiftKey: true },
];

const editable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|number|url|email|)$/.test(el.type)));

/** What's selected: in the focused field, else on the page. */
export function selectedText(doc: Document = document): string {
  const el = doc.activeElement;
  if (editable(el) && el.selectionStart !== null && el.selectionEnd !== null) return el.value.slice(el.selectionStart, el.selectionEnd);
  return doc.getSelection()?.toString() ?? "";
}

/** One editing key, done the way the browser would: true when it was one of ours. */
export function handleEditKey(event: KeyboardEvent, clipboard: Clipboard, doc: Document = document): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey) return false;
  const key = event.key.toLowerCase();
  const field = editable(doc.activeElement) ? doc.activeElement : null;
  const run = (command: string, value?: string) => doc.execCommand(command, false, value);
  if (key === "c" && !event.shiftKey) {
    const text = selectedText(doc);
    if (text) clipboard.write(text);
  } else if (key === "x" && !event.shiftKey) {
    const text = selectedText(doc);
    if (!field || !text) return false;
    clipboard.write(text);
    run("delete");
  } else if (key === "v" && !event.shiftKey) {
    if (!field) return false;
    const text = clipboard.read();
    if (text) run("insertText", text);
  } else if (key === "z") {
    if (!field) return false;
    run(event.shiftKey ? "redo" : "undo");
  } else if (key === "a" && !event.shiftKey) {
    if (field) field.select();
    else run("selectAll");
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

/** Takes the editing keys from Premiere and handles them in this panel. Returns its undo. */
export function installEditKeys(clipboard: Clipboard, win: Window = window): () => void {
  const cep = (win as unknown as { __adobe_cep__?: AdobeCep }).__adobe_cep__;
  try {
    cep?.registerKeyEventsInterest?.(JSON.stringify(KEY_INTEREST));
  } catch {
    // An older CEP: the keys stay Premiere's, and the fields' context menus still work.
  }
  const onKey = (event: KeyboardEvent) => void handleEditKey(event, clipboard, win.document);
  win.document.addEventListener("keydown", onKey);
  return () => win.document.removeEventListener("keydown", onKey);
}

/** The Mac's pasteboard through CEP's Node. */
export function pasteboard(nodeRequire: (module: string) => unknown): Clipboard {
  const child = nodeRequire("child_process") as {
    execFileSync(file: string, args: string[], options: { input?: string; encoding: "utf8"; timeout: number }): string;
  };
  return {
    read: () => {
      try {
        return child.execFileSync("/usr/bin/pbpaste", [], { encoding: "utf8", timeout: 2000 });
      } catch {
        return "";
      }
    },
    write: (text) => {
      try {
        child.execFileSync("/usr/bin/pbcopy", [], { input: text, encoding: "utf8", timeout: 2000 });
      } catch {
        // Nothing copied; the selection stays.
      }
    },
  };
}
