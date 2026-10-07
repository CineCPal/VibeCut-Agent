import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { ImagePlus, Pencil, SendHorizontal, Square, X } from "lucide-react";
import { MAX_IMAGES, addImagesTo, imageFiles } from "../../lib/agent/attachments";
import { cancelEditing, lastTurnEdits, sendEditedMessage, sendUserMessage, startEditingLastMessage, stopTurn } from "../../lib/agent/controller";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { matchingPrompts, usePromptStore, type SavedPrompt } from "../../store/usePromptStore";
import type { AgentStatus } from "../../types/agent";

/** Why the composer can't send right now, or null if it can. */
export function composerBlockReason(status: AgentStatus, statusDetail: string | null, outsideRunning = false): string | null {
  if (status === "offline") return statusDetail ?? "Agent offline";
  if (status === "error") return statusDetail ?? "The agent hit an error";
  if (status === "thinking") return "Agent is working…";
  if (status === "stopping") return "Stopping…";
  if (outsideRunning) return "Claude Code is editing from outside…";
  return null;
}

/** Adds images to the composer (a pick, a paste, or a drop on the chat). Answers why any were left out. */
export function attachImages(files: File[]): Promise<string | null> {
  const store = useAgentStore.getState;
  return addImagesTo(files, () => store().pendingImages, (images) => store().setPendingImages(images));
}

export function Composer() {
  const draft = useAgentStore((s) => s.draft);
  const status = useAgentStore((s) => s.status);
  const statusDetail = useAgentStore((s) => s.statusDetail);
  const setDraft = useAgentStore((s) => s.setDraft);
  const outsideRunning = useMcpStore((s) => s.outsideRunning > 0);
  const editing = useAgentStore((s) => s.editingMessageId);
  const images = useAgentStore((s) => s.pendingImages);
  const setImages = useAgentStore((s) => s.setPendingImages);
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Saved prompts (Phase 8h): "/" then a name, alone in the box, lists them.
  const prompts = usePromptStore((s) => s.prompts);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const selectAfterInsert = useRef<[number, number] | null>(null);
  const slash = /^\/([a-z0-9-]*)$/i.exec(draft);
  const matches = slash && draft !== dismissed ? matchingPrompts(prompts, slash[1]) : [];
  const listOpen = matches.length > 0;
  const activeIndex = Math.min(active, matches.length - 1);
  const listId = `${hintId}-prompts`;
  const optionId = (prompt: SavedPrompt) => `${listId}-${prompt.id}`;

  const insertPrompt = (prompt: SavedPrompt) => {
    // A {{…}} in it is selected, ready to type over; otherwise the caret goes to the end.
    const blank = /\{\{[^}]*\}\}/.exec(prompt.body);
    selectAfterInsert.current = blank ? [blank.index, blank.index + blank[0].length] : [prompt.body.length, prompt.body.length];
    setDraft(prompt.body);
    setActive(0);
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    const range = selectAfterInsert.current;
    if (!input || !range) return;
    selectAfterInsert.current = null;
    input.focus();
    input.setSelectionRange(range[0], range[1]);
  }, [draft]);

  // Editing starts from the message's pencil too: the box takes focus with the caret at the end.
  useEffect(() => {
    const input = inputRef.current;
    if (!editing || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const blocked = composerBlockReason(status, statusDetail, outsideRunning);
  const canSend = !blocked && (draft.trim().length > 0 || images.length > 0);
  const offline = status === "offline" || status === "error";
  const running = status === "thinking" || status === "stopping";

  const send = () => {
    if (!canSend) return;
    const text = draft;
    const sent = images;
    setDraft("");
    setImages([]);
    setImageProblem(null);
    // What wasn't sent goes back in the box, unless something new was put there since.
    const putBack = () => {
      const now = useAgentStore.getState();
      if (!now.draft) setDraft(text);
      if (!now.pendingImages.length) setImages(sent);
    };
    if (editing) {
      useAgentStore.getState().setEditing(null);
      void sendEditedMessage(text, sent).catch((error: unknown) => {
        // Nothing was taken back: the edited message goes back in the box, to send as a new one.
        useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
        putBack();
      });
    } else {
      void sendUserMessage(text, sent).then((ok) => {
        if (!ok && sent.length) putBack();
      });
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const addImages = async (files: File[]) => {
    if (!files.length) return;
    setImageProblem(await attachImages(files));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(event.clipboardData?.files);
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && !event.nativeEvent.isComposing) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step) {
        event.preventDefault();
        setActive((activeIndex + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        insertPrompt(matches[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(draft);
        return;
      }
    }
    if (event.key === "Backspace" && !draft && images.length) {
      // Backspace in an empty box takes the last image off.
      event.preventDefault();
      setImages(images.slice(0, -1));
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "ArrowUp" && !draft && !editing && !event.shiftKey && !event.altKey && !event.metaKey) {
      // ↑ in an empty box edits the last message (Phase 8c).
      if (startEditingLastMessage()) event.preventDefault();
    } else if (event.key === "Escape" && editing) {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
    }
  };

  const onChange = (value: string) => {
    setDraft(value);
    setActive(0);
    // Clearing the box is a way out of editing too.
    if (editing && !value) useAgentStore.getState().setEditing(null);
  };

  const editCount = editing ? lastTurnEdits().length : 0;

  return (
    <form onSubmit={onSubmit} className="border-t border-border bg-surface px-3 py-2">
      {editing ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-athletic-blue-light">
          <Pencil size={11} aria-hidden="true" />
          <span className="flex-1">
            Editing your last message · Esc to cancel
            {editCount ? ` · its ${editCount} edit${editCount === 1 ? " is" : "s are"} reverted when you send` : ""}
          </span>
          <button type="button" onClick={cancelEditing} aria-label="Cancel editing" className="rounded p-0.5 text-cool-grey hover:text-white">
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {images.length ? (
        <ul aria-label="Images to send" className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((image) => (
            <li key={image.id} className="relative">
              <img
                src={image.dataUrl}
                alt={image.name}
                title={`${image.name} · ${image.width}×${image.height}`}
                className="h-12 w-12 rounded border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => setImages(useAgentStore.getState().pendingImages.filter((i) => i.id !== image.id))}
                aria-label={`Remove ${image.name}`}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface p-0.5 text-cool-grey hover:text-white focus-visible:text-white"
              >
                <X size={10} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {imageProblem ? (
        <p role="alert" className="mb-1 text-[11px] text-warning">
          {imageProblem}
        </p>
      ) : null}
      {listOpen ? (
        <ul id={listId} role="listbox" aria-label="Saved prompts" className="mb-1.5 max-h-44 overflow-y-auto rounded-md border border-border bg-canvas py-1">
          {matches.map((prompt, index) => (
            <li
              key={prompt.id}
              id={optionId(prompt)}
              role="option"
              aria-selected={index === activeIndex}
              // Pressed without taking focus from the box.
              onMouseDown={(event) => {
                event.preventDefault();
                insertPrompt(prompt);
              }}
              className={`flex cursor-pointer items-baseline gap-2 px-2 py-1 text-xs ${index === activeIndex ? "bg-athletic-blue text-white" : "text-warm-grey hover:bg-surface"}`}
            >
              <span className="shrink-0 font-mono text-athletic-blue-light">/{prompt.name}</span>
              <span className="truncate text-cool-grey">{prompt.body}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            void addImages(imageFiles(event.target.files));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={offline || images.length >= MAX_IMAGES}
          aria-label="Add images"
          title={images.length >= MAX_IMAGES ? `At most ${MAX_IMAGES} images per message` : "Add images (or paste or drop them)"}
          className="rounded-md p-2 text-cool-grey hover:text-athletic-blue-light focus-visible:text-athletic-blue-light disabled:opacity-40"
        >
          <ImagePlus size={16} aria-hidden="true" />
        </button>
        <label className="sr-only" htmlFor={`${hintId}-input`}>
          Message the agent
        </label>
        <textarea
          id={`${hintId}-input`}
          ref={inputRef}
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? optionId(matches[activeIndex]) : undefined}
          rows={2}
          disabled={offline}
          aria-describedby={hintId}
          placeholder={offline ? (blocked ?? "") : "Ask the agent about your timeline…"}
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-white placeholder:text-cool-grey disabled:cursor-not-allowed disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            onClick={() => void stopTurn()}
            disabled={status === "stopping"}
            aria-label="Stop the agent"
            className="rounded-md border border-loss/60 p-2 text-loss hover:bg-loss/10 disabled:opacity-40"
          >
            <Square size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label={editing ? "Send edited message" : "Send message"}
            className="rounded-md bg-athletic-blue p-2 text-athletic-blue-light hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <p id={hintId} className="mt-1 text-[11px] text-cool-grey">
        {blocked ??
          (listOpen
            ? "↑↓ to choose · Enter or Tab to use · Esc to close"
            : `Enter to send · Shift+Enter for a new line · / for saved prompts · up to ${MAX_IMAGES} images`)}
      </p>
    </form>
  );
}
