import { useState } from "react";
import type { HostPanelStateFile } from "../src/types/hostPanel";
import { Press } from "./Press";
import type { HostPanelView } from "./useHostPanel";

/**
 * The History tab of the "VibeCut Agent" panel: the app's past chats, newest first, filtered by title.
 * Opening one shows it in the Chat tab, and in the app's window, which follows the same conversation.
 */

const DAY_MS = 86_400_000;

/** "Today", "Yesterday", "3 days ago", or the date. */
export function relativeDay(at: number, now = Date.now()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.ceil((start.getTime() - at) / DAY_MS);
  if (at >= start.getTime()) return "Today";
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

export function HistoryTab({ state, view, onOpen }: { state: HostPanelStateFile; view: HostPanelView; onOpen: () => void }) {
  const [filter, setFilter] = useState("");
  const running = state.agent.status === "thinking" || state.agent.status === "stopping";
  const words = filter.trim().toLowerCase();
  const chats = state.history.filter((c) => !words || c.title.toLowerCase().includes(words));
  const open = (chatId: string) => {
    view.act({ type: "load_chat", chatId });
    onOpen();
  };
  return (
    <div className="vc-history">
      <div className="vc-history-bar">
        <div className="vc-row">
          <span className="vc-grow vc-faint">{state.history.length ? `${state.history.length} saved chats` : "No saved chats yet"}</span>
          <Press
            className="vc-btn"
            disabled={running}
            onClick={() => {
              view.act({ type: "new_chat" });
              onOpen();
            }}
          >
            New chat
          </Press>
        </div>
        <input className="vc-input vc-history-search" type="search" value={filter} placeholder="Filter by title" aria-label="Filter chats" onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="vc-history-list">
        {running && <p className="vc-faint">Stop or finish the current request to open another chat.</p>}
        {words && !chats.length && <p className="vc-muted vc-empty">No chat's title has “{filter.trim()}”.</p>}
        <ul className="vc-acts">
          {chats.map((c) => {
            const current = c.id === state.chat.chatId;
            return (
              <li key={c.id} className="vc-act">
                <Press className="vc-link vc-row" disabled={running || current} onClick={() => open(c.id)} aria-current={current ? "true" : undefined} title={current ? "This is the open chat" : `Open “${c.title}”`}>
                  <span className="vc-grow vc-truncate">{c.title || "Untitled chat"}</span>
                  <span className="vc-faint">
                    {c.messageCount} · {relativeDay(c.updatedAt)}
                  </span>
                </Press>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
