import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { History, Pencil, Search, Trash2 } from "lucide-react";
import { deleteChat, openChat, renameChat } from "../../lib/agent/chatHistory";
import { searchChats } from "../../lib/ipc";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useUiStore } from "../../store/useUiStore";
import type { ChatSearchHit } from "../../types/history";

/** How long typing pauses before the messages are searched (titles filter at once). */
export const SEARCH_DELAY_MS = 150;

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

/** A search hit's words, with the match marked. */
function Snippet({ hit }: { hit: ChatSearchHit }) {
  const chars = [...hit.snippet];
  return (
    <span className="block truncate text-[11px] text-warm-grey">
      {chars.slice(0, hit.matchStart).join("")}
      <mark className="rounded-sm bg-athletic-blue-light/30 text-white">{chars.slice(hit.matchStart, hit.matchEnd).join("")}</mark>
      {chars.slice(hit.matchEnd).join("")}
    </span>
  );
}

/**
 * The chat's past chats (Phase 8a): a button and a list under it, opened with ⌘Y too. Phase 8d adds a
 * search box (titles filter as you type; what was said is searched a moment later) and renaming.
 *
 * Keys, from the search box or the list: ↑↓ / Home / End move, Enter opens, F2 renames, Escape clears the
 * search, then closes. From the list (Tab to it), Delete asks once and deletes on the second press.
 * While a request runs, the list can be read and renamed but not switched.
 */
export function ChatHistoryMenu({ busy }: { busy: boolean }) {
  const open = useUiStore((s) => s.historyOpen);
  const setOpen = useUiStore((s) => s.setHistoryOpen);
  const chats = useChatHistoryStore((s) => s.chats);
  const chatId = useAgentStore((s) => s.chatId);
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChatSearchHit[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setConfirming(null);
    setRenaming(null);
    setError(null);
    setQuery("");
    setHits(null);
    searchRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, setOpen]);

  // What was said, searched once typing pauses; an answer for an older query is dropped.
  useEffect(() => {
    const words = query.trim();
    if (!open || !words) {
      setHits(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      searchChats(words)
        .then((found) => current && setHits(found))
        .catch(() => current && setHits([]));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  const rows = useMemo(() => {
    const all = chats ?? [];
    const words = query.trim().toLowerCase();
    if (!words) return all.map((chat) => ({ chat, hit: undefined as ChatSearchHit | undefined }));
    const byId = new Map((hits ?? []).map((h) => [h.id, h]));
    return all
      .filter((chat) => chat.title.toLowerCase().includes(words) || byId.has(chat.id))
      .map((chat) => {
        const hit = byId.get(chat.id);
        // A hit on the title says nothing the title doesn't.
        return { chat, hit: hit && hit.snippet !== chat.title ? hit : undefined };
      });
  }, [chats, hits, query]);

  useEffect(() => {
    setActive((i) => Math.max(0, Math.min(i, rows.length - 1)));
  }, [rows.length]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startRename = (id: string) => {
    const row = rows.find((r) => r.chat.id === id);
    if (!row) return;
    setConfirming(null);
    setRenaming({ id, value: row.chat.title });
  };

  const finishRename = async (save: boolean) => {
    const current = renaming;
    setRenaming(null);
    searchRef.current?.focus();
    if (!save || !current) return;
    try {
      await renameChat(current.id, current.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** The keys the search box and the list share. True when handled. */
  const navigate = (event: KeyboardEvent<HTMLElement>): boolean => {
    const row = rows[active];
    switch (event.key) {
      case "ArrowDown":
        setConfirming(null);
        setActive((i) => Math.min(rows.length - 1, i + 1));
        return true;
      case "ArrowUp":
        setConfirming(null);
        setActive((i) => Math.max(0, i - 1));
        return true;
      case "Home":
        setActive(0);
        return true;
      case "End":
        setActive(Math.max(0, rows.length - 1));
        return true;
      case "Enter":
        if (row) void choose(row.chat.id);
        return true;
      case "F2":
        if (row) startRename(row.chat.id);
        return true;
      case "Escape":
        event.stopPropagation();
        if (confirming) setConfirming(null);
        else if (query) setQuery("");
        else close();
        return true;
      default:
        return false;
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Home and End stay with the text being typed.
    if (event.key === "Home" || event.key === "End") return;
    if (navigate(event)) event.preventDefault();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (navigate(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const row = rows[active];
      if (row) void remove(row.chat.id);
    }
  };

  const hint = busy
    ? "Finish or stop the current request to switch chats."
    : "↑↓ to move · Enter to open · F2 to rename · Tab, then Delete twice to remove";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={!chats?.length}
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
        <div className="absolute right-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-surface shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
            <Search size={12} aria-hidden="true" className="shrink-0 text-cool-grey" />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-label="Search past chats"
              aria-controls={listId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={rows[active] ? `${listId}-${rows[active].chat.id}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setConfirming(null);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search names and messages"
              className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-cool-grey outline-none"
            />
          </div>
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-cool-grey">{query.trim() ? (hits === null ? "Searching…" : "No chats match") : "No past chats yet."}</p>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Past chats"
              aria-activedescendant={rows[active] ? `${listId}-${rows[active].chat.id}` : undefined}
              tabIndex={0}
              onKeyDown={onListKeyDown}
              className="max-h-72 overflow-y-auto py-1 outline-none"
            >
              {rows.map(({ chat, hit }, i) => (
                <li
                  key={chat.id}
                  id={`${listId}-${chat.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={busy}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => (renaming?.id === chat.id ? undefined : void choose(chat.id))}
                  className={`group flex cursor-pointer items-start gap-2 px-3 py-1.5 text-xs ${i === active ? "bg-athletic-blue/60" : ""} ${busy ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    {renaming?.id === chat.id ? (
                      <input
                        autoFocus
                        aria-label={`New name for "${chat.title}"`}
                        value={renaming.value}
                        maxLength={120}
                        onChange={(e) => setRenaming({ id: chat.id, value: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void finishRename(true);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            void finishRename(false);
                          }
                        }}
                        onBlur={() => void finishRename(false)}
                        className="w-full rounded border border-athletic-blue-light/60 bg-canvas px-1 py-0.5 text-xs text-white outline-none"
                      />
                    ) : (
                      <span className="block truncate text-white">{chat.title}</span>
                    )}
                    {hit ? <Snippet hit={hit} /> : null}
                    <span className="block text-[11px] text-cool-grey">
                      {chat.id === chatId ? "Open now · " : ""}
                      {relativeTime(chat.updatedAt)} · {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className={`flex shrink-0 items-center ${i === active || confirming === chat.id ? "" : "opacity-0 group-hover:opacity-100"}`}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        startRename(chat.id);
                      }}
                      aria-label={`Rename "${chat.title}"`}
                      className="rounded px-1 py-0.5 text-cool-grey hover:text-athletic-blue-light"
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void remove(chat.id);
                      }}
                      aria-label={confirming === chat.id ? `Confirm deleting "${chat.title}"` : `Delete "${chat.title}"`}
                      className={`rounded px-1 py-0.5 ${confirming === chat.id ? "text-loss" : "text-cool-grey"} hover:text-loss disabled:opacity-40`}
                    >
                      {confirming === chat.id ? "Delete?" : <Trash2 size={12} aria-hidden="true" />}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-cool-grey" role={error ? "alert" : undefined}>
            {error ?? hint}
          </p>
        </div>
      ) : null}
    </div>
  );
}
