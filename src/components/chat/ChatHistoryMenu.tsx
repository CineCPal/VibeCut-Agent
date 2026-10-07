import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { History, Trash2 } from "lucide-react";
import { deleteChat, openChat } from "../../lib/agent/chatHistory";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useUiStore } from "../../store/useUiStore";

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The chat's past chats (Phase 8a): a button and a list under it, opened with ⌘Y too. Arrow keys move,
 * Enter opens, Delete asks once and deletes on the second press, Escape closes. While a request runs the
 * list can be read but not switched.
 */
export function ChatHistoryMenu({ busy }: { busy: boolean }) {
  const open = useUiStore((s) => s.historyOpen);
  const setOpen = useUiStore((s) => s.setHistoryOpen);
  const chats = useChatHistoryStore((s) => s.chats) ?? [];
  const chatId = useAgentStore((s) => s.chatId);
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setConfirming(null);
    setError(null);
    listRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, setOpen]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const choose = async (id: string) => {
    if (busy) return;
    try {
      await openChat(id);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    try {
      await deleteChat(id);
      setActive((i) => Math.max(0, Math.min(i, chats.length - 2)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = chats[active];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setConfirming(null);
        setActive((i) => Math.min(chats.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setConfirming(null);
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(Math.max(0, chats.length - 1));
        break;
      case "Enter":
        event.preventDefault();
        if (row) void choose(row.id);
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        if (row) void remove(row.id);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (confirming) setConfirming(null);
        else close();
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={chats.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title="Past chats (⌘Y)"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40"
      >
        <History size={12} aria-hidden="true" />
        History
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-surface shadow-lg">
          {chats.length === 0 ? (
            <p className="px-3 py-2 text-xs text-cool-grey">No past chats yet.</p>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Past chats"
              aria-activedescendant={chats[active] ? `${listId}-${chats[active].id}` : undefined}
              tabIndex={0}
              onKeyDown={onKeyDown}
              className="max-h-72 overflow-y-auto py-1 outline-none"
            >
              {chats.map((chat, i) => (
                <li
                  key={chat.id}
                  id={`${listId}-${chat.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={busy}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(chat.id)}
                  className={`group flex cursor-pointer items-start gap-2 px-3 py-1.5 text-xs ${i === active ? "bg-athletic-blue/60" : ""} ${busy ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-white">{chat.title}</span>
                    <span className="block text-[11px] text-cool-grey">
                      {chat.id === chatId ? "Open now · " : ""}
                      {relativeTime(chat.updatedAt)} · {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(chat.id);
                    }}
                    aria-label={confirming === chat.id ? `Confirm deleting "${chat.title}"` : `Delete "${chat.title}"`}
                    className={`shrink-0 rounded px-1 py-0.5 ${confirming === chat.id ? "text-loss" : "text-cool-grey opacity-0 group-hover:opacity-100"} ${i === active ? "opacity-100" : ""} hover:text-loss disabled:opacity-40`}
                  >
                    {confirming === chat.id ? "Delete?" : <Trash2 size={12} aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-cool-grey" role={error ? "alert" : undefined}>
            {error ?? (busy ? "Finish or stop the current request to switch chats." : "↑↓ to move · Enter to open · Delete twice to remove")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
