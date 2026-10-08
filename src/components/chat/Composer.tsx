import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { ImagePlus, ListPlus, Pencil, SendHorizontal, Square, X } from "lucide-react";
import { MAX_IMAGES, addImagesTo, imageFiles } from "../../lib/agent/attachments";
import { cancelEditing, lastTurnEdits, sendEditedMessage, startEditingLastMessage, stopTurn, submitMessage, warmUp } from "../../lib/agent/controller";
import { allMentions, loadMentionTimeline, matchingMentions, mentionQuery, MENTION_GROUPS } from "../../lib/agent/mentions";
import { MAX_QUEUE, useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { matchingPrompts, usePromptStore } from "../../store/usePromptStore";
import type { AgentStatus, ChatMention } from "../../types/agent";
import { QueueList } from "./QueueList";
import { SuggestionList, suggestionOptionId, type Suggestion } from "./SuggestionList";

/** Why the composer can't send right now, or null if it can. */
export function composerBlockReason(status: AgentStatus, statusDetail: string | null, outsideRunning = false): string | null {
  if (status === "offline") return statusDetail ?? "Agent offline";
  if (status === "error") return statusDetail ?? "The agent hit an error";
  if (status === "thinking") return "Agent is working…";
  if (status === "stopping") return "Stopping…";
  if (outsideRunning) return "Claude Code is editing from outside…";
  return null;
}

/** Why nothing can be sent or queued (the agent can't chat at all), or null. */
function hardBlock(status: AgentStatus, statusDetail: string | null): string | null {
  return status === "offline" || status === "error" ? composerBlockReason(status, statusDetail) : null;
}

const GROUP_LABEL = Object.fromEntries(MENTION_GROUPS.map((g) => [g.kind, g.label]));

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
  const queueLength = useAgentStore((s) => s.queue.length);
  const draftMentions = useAgentStore((s) => s.draftMentions);
  const setDraftMentions = useAgentStore((s) => s.setDraftMentions);
  // Where the caret is, for an @-mention being typed before it (Phase 11c).
  const [caret, setCaret] = useState(0);
  const [, setTimelineLoaded] = useState(0);
  const [active, setActive] = useState(0);
  // The draft as it was when Escape closed a list: it stays closed until the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const selectAfterInsert = useRef<[number, number] | null>(null);

  // Saved prompts (Phase 8h): "/" then a name, alone in the box, lists them.
  const prompts = usePromptStore((s) => s.prompts);
  const slash = /^\/([a-z0-9-]*)$/i.exec(draft);
  const promptMatches = slash && draft !== dismissed ? matchingPrompts(prompts, slash[1]) : [];
  // @-mentions (Phase 11c): "@" and the start of a name, just before the caret.
  const mention = !slash && draft !== dismissed ? mentionQuery(draft, caret) : null;
  const mentionMatches: ChatMention[] = mention ? matchingMentions(allMentions(), mention.query) : [];

  const promptList = promptMatches.length > 0;
  const items: Suggestion[] = promptList
    ? promptMatches.map((p) => ({ key: p.id, primary: `/${p.name}`, secondary: p.body }))
    : mentionMatches.map((m, i) => ({ key: `${m.kind}-${i}-${m.ref}`, primary: m.label, secondary: m.detail, group: GROUP_LABEL[m.kind] }));
  const listOpen = items.length > 0;
  const activeIndex = Math.min(active, items.length - 1);
  const listId = `${hintId}-${promptList ? "prompts" : "mentions"}`;

  // The first time the @ list opens with no timeline read yet, it's read once for its clips and markers.
  const mentionOpen = mention !== null;
  useEffect(() => {
    if (!mentionOpen) return;
    let live = true;
    void loadMentionTimeline().then((loaded) => live && loaded && setTimelineLoaded((n) => n + 1));
    return () => {
      live = false;
    };
  }, [mentionOpen]);

  const insertPrompt = (index: number) => {
    const prompt = promptMatches[index];
    // A {{…}} in it is selected, ready to type over; otherwise the caret goes to the end.
    const blank = /\{\{[^}]*\}\}/.exec(prompt.body);
    selectAfterInsert.current = blank ? [blank.index, blank.index + blank[0].length] : [prompt.body.length, prompt.body.length];
    setDraft(prompt.body);
    setActive(0);
  };

  const insertMention = (index: number) => {
    const picked = mentionMatches[index];
    if (!mention || !picked) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const inserted = `@${picked.label}${after.startsWith(" ") ? "" : " "}`;
    const at = before.length + inserted.length;
    selectAfterInsert.current = [at, at];
    setDraft(before + inserted + after);
    setCaret(at);
    setDraftMentions([...draftMentions.filter((m) => !(m.kind === picked.kind && m.label === picked.label)), picked]);
    setActive(0);
  };

  const pick = (index: number) => (promptList ? insertPrompt(index) : insertMention(index));

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

  const blocked = hardBlock(status, statusDetail);
  const offline = blocked !== null;
  const running = status === "thinking" || status === "stopping";
  // While a turn runs (or Claude Code edits from outside, or messages already wait), a message queues (Phase 11b).
  const queueing = running || outsideRunning || queueLength > 0;
  const queueFull = queueing && queueLength >= MAX_QUEUE;
  const hasContent = draft.trim().length > 0 || images.length > 0;
  const canSend = !blocked && !queueFull && !(editing && queueing) && hasContent;

  const send = () => {
    if (!canSend) return;
    const text = draft;
    const sent = images;
    const mentions = draftMentions;
    setDraft("");
    setImages([]);
    setDraftMentions([]);
    setImageProblem(null);
    // What wasn't sent goes back in the box, unless something new was put there since.
    const putBack = () => {
      const now = useAgentStore.getState();
      if (!now.draft) {
        setDraft(text);
        setDraftMentions(mentions);
      }
      if (!now.pendingImages.length) setImages(sent);
    };
    if (editing) {
      useAgentStore.getState().setEditing(null);
      void sendEditedMessage(text, sent, mentions).catch((error: unknown) => {
        // Nothing was taken back: the edited message goes back in the box, to send as a new one.
        useAgentStore.getState().addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
        putBack();
      });
    } else {
      void submitMessage(text, sent, mentions).then((outcome) => {
        if (!outcome && (sent.length || queueing)) putBack();
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
        setActive((activeIndex + step + items.length) % items.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pick(activeIndex);
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

  const onChange = (value: string, caretAt: number) => {
    // The first words typed start the agent's job, so it's ready by Send (Phase 11f).
    if (!draft && value && !editing && status === "idle") warmUp();
    setDraft(value);
    setCaret(caretAt);
    setActive(0);
    if (!value) setDraftMentions([]);
    // Clearing the box is a way out of editing too.
    if (editing && !value) useAgentStore.getState().setEditing(null);
  };

  const trackCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart ?? 0);

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
      <QueueList />
      {listOpen ? (
        <SuggestionList id={listId} label={promptList ? "Saved prompts" : "Mention"} items={items} active={activeIndex} onPick={pick} mono={promptList} />
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
          onChange={(event) => onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onKeyDown={onKeyDown}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onSelect={trackCaret}
          onPaste={onPaste}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? suggestionOptionId(listId, items[activeIndex]) : undefined}
          rows={2}
          disabled={offline}
          aria-describedby={hintId}
          placeholder={offline ? (blocked ?? "") : "Ask the agent about your timeline…"}
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-white placeholder:text-cool-grey disabled:cursor-not-allowed disabled:opacity-60"
        />
        {queueing && !editing ? (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Queue message"
            title={queueFull ? `At most ${MAX_QUEUE} messages can wait` : "Queue it: it's sent when the agent finishes"}
            className="rounded-md border border-border p-2 text-athletic-blue-light hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ListPlus size={16} aria-hidden="true" />
          </button>
        ) : null}
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
        ) : !queueing || editing ? (
          <button
            type="submit"
            disabled={!canSend}
            aria-label={editing ? "Send edited message" : "Send message"}
            className="rounded-md bg-athletic-blue p-2 text-athletic-blue-light hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p id={hintId} className="mt-1 text-[11px] text-cool-grey">
        {blocked ??
          (listOpen
            ? "↑↓ to choose · Enter or Tab to use · Esc to close"
            : queueing
              ? `${composerBlockReason(status, statusDetail, outsideRunning) ?? "Messages are waiting"} ${queueFull ? `· the queue is full (${MAX_QUEUE})` : "· Enter to queue a message"}`
              : `Enter to send · Shift+Enter for a new line · / for saved prompts · @ to point at a clip, marker or shot · up to ${MAX_IMAGES} images`)}
      </p>
    </form>
  );
}
