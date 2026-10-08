/** The composer's pop-up lists (saved prompts on "/", Phase 8h; @-mentions, Phase 11c): a listbox the
 * textarea drives with aria-activedescendant, picked with the mouse without taking focus from the box. */
export interface Suggestion {
  key: string;
  primary: string;
  secondary?: string;
  /** A heading shown above the first item of each group. */
  group?: string;
}

export const suggestionOptionId = (listId: string, item: Suggestion) => `${listId}-${item.key.replace(/[^\w-]/g, "_")}`;

export function SuggestionList({
  id,
  label,
  items,
  active,
  onPick,
  mono = false,
}: {
  id: string;
  label: string;
  items: Suggestion[];
  active: number;
  onPick: (index: number) => void;
  /** Shows the primary text in the monospace accent ("/name"). */
  mono?: boolean;
}) {
  return (
    <ul id={id} role="listbox" aria-label={label} className="mb-1.5 max-h-52 overflow-y-auto rounded-md border border-border bg-canvas py-1">
      {items.map((item, index) => {
        const heading = item.group && item.group !== items[index - 1]?.group ? item.group : null;
        return (
          <li key={item.key} role="presentation">
            {heading ? (
              <p role="presentation" className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-cool-grey">
                {heading}
              </p>
            ) : null}
            <div
              id={suggestionOptionId(id, item)}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(index);
              }}
              className={`flex cursor-pointer items-baseline gap-2 px-2 py-1 text-xs ${index === active ? "bg-athletic-blue text-white" : "text-warm-grey hover:bg-surface"}`}
            >
              <span className={`shrink-0 ${mono ? "font-mono text-athletic-blue-light" : "max-w-[60%] truncate"}`}>{item.primary}</span>
              {item.secondary ? <span className="truncate text-cool-grey">{item.secondary}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
