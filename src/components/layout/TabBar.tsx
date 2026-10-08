import { useRef, type KeyboardEvent } from "react";
import { Library, MessageSquare, Sparkles } from "lucide-react";
import { useUiStore, type Tab } from "../../store/useUiStore";

export const TABS: { id: Tab; label: string; shortcut: string; hint: string; Icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Agent", shortcut: "⌘1", hint: "The editing agent", Icon: MessageSquare },
  { id: "library", label: "Library", shortcut: "⌘2", hint: "Search and browse Spyglass's index of your archive", Icon: Library },
  { id: "broll", label: "Analyze", shortcut: "⌘3", hint: "Rank the clips in a folder on disk and export the best segments (B-Roll Analyzer)", Icon: Sparkles },
];

export const tabId = (tab: Tab) => `tab-${tab}`;
export const panelId = (tab: Tab) => `panel-${tab}`;

export function TabBar() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ chat: null, library: null, broll: null });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next].id;
    setTab(target);
    refs.current[target]?.focus();
  };

  return (
    <div role="tablist" aria-label="Panels" className="flex gap-1 border-b border-border px-2" onKeyDown={onKeyDown}>
      {TABS.map(({ id, label, shortcut, hint, Icon }) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            id={tabId(id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId(id)}
            tabIndex={selected ? 0 : -1}
            title={`${hint} (${shortcut})`}
            onClick={() => setTab(id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              selected
                ? "border-athletic-blue-light text-white"
                : "border-transparent text-cool-grey hover:text-warm-grey"
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
