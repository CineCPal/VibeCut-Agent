import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const controller = vi.hoisted(() => ({
  submitMessage: vi.fn(async (..._args: unknown[]): Promise<"sent" | "queued" | false> => "sent"),
  warmUp: vi.fn(),
  editQueued: vi.fn(),
  resumeQueue: vi.fn(),
  stopTurn: vi.fn(),
  sendEditedMessage: vi.fn(async () => undefined),
  startEditingLastMessage: vi.fn(() => false),
  cancelEditing: vi.fn(),
  lastTurnEdits: vi.fn(() => [] as string[]),
}));
vi.mock("../../lib/agent/controller", () => controller);
// Decoding and redrawing need a real browser: here an image is whatever the file says it is.
vi.mock("../../lib/agent/attachments", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/agent/attachments")>();
  const prepareImage = async (blob: Blob, name: string) => {
    if (name.startsWith("broken")) throw new Error(`${name} couldn't be read as an image`);
    return { id: name, name, mime: blob.type, width: 10, height: 10, bytes: blob.size, data: "AAAA", dataUrl: `data:${blob.type};base64,AAAA` };
  };
  return { ...real, prepareImage, addImagesTo: (files: File[], get: never, set: never) => real.addImagesTo(files, get, set, prepareImage) };
});

import { Composer, composerBlockReason } from "./Composer";
import { AGENT_OFFLINE_DETAIL, useAgentStore } from "../../store/useAgentStore";
import { waitFor } from "@testing-library/react";
import { usePromptStore } from "../../store/usePromptStore";

const png = (name: string) => new File(["png-bytes"], name, { type: "image/png" });
const paste = (input: HTMLElement, files: File[]) => fireEvent.paste(input, { clipboardData: { files } });

describe("Composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({ messages: [], status: "offline", statusDetail: AGENT_OFFLINE_DETAIL, draft: "", editingMessageId: null, pendingImages: [], draftMentions: [], queue: [], queuePaused: false });
  });

  it("explains why it can't send", () => {
    expect(composerBlockReason("offline", null)).toBe("Agent offline");
    expect(composerBlockReason("thinking", null)).toBe("Agent is working…");
    expect(composerBlockReason("stopping", null)).toBe("Stopping…");
    expect(composerBlockReason("error", "uv not found")).toBe("uv not found");
    expect(composerBlockReason("idle", null)).toBeNull();
  });

  it("is disabled with the reason while the agent is offline", () => {
    render(<Composer />);
    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText(AGENT_OFFLINE_DETAIL)).toBeInTheDocument();
  });

  it("sends on Enter when idle and keeps Shift+Enter as a newline", () => {
    useAgentStore.setState({ status: "idle", statusDetail: null });
    render(<Composer />);
    const input = screen.getByLabelText("Message the agent");

    fireEvent.change(input, { target: { value: "Duck the music under dialogue" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(controller.submitMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(controller.submitMessage).toHaveBeenCalledWith("Duck the music under dialogue", [], []);
    expect(controller.warmUp).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().draft).toBe("");
  });

  it("does not send blank drafts", () => {
    useAgentStore.setState({ status: "idle", statusDetail: null, draft: "   " });
    render(<Composer />);
    fireEvent.keyDown(screen.getByLabelText("Message the agent"), { key: "Enter" });
    expect(controller.submitMessage).not.toHaveBeenCalled();
  });

  it("offers Stop while a turn runs", () => {
    useAgentStore.setState({ status: "thinking", statusDetail: null });
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(controller.stopTurn).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Agent is working… · Enter to queue a message$/)).toBeInTheDocument();
  });

  describe("the queue (Phase 11b)", () => {
    it("queues on Enter while a turn runs, and lists what waits", () => {
      useAgentStore.setState({ status: "thinking", statusDetail: null });
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      expect(input).not.toBeDisabled();
      fireEvent.change(input, { target: { value: "Then add markers" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(controller.submitMessage).toHaveBeenCalledWith("Then add markers", [], []);
      expect(controller.warmUp).not.toHaveBeenCalled();

      act(() => void useAgentStore.getState().enqueue({ text: "Then add markers", images: [], mentions: [] }));
      expect(screen.getByRole("region", { name: "Queued messages" })).toHaveTextContent("Then add markers");
      fireEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
      expect(useAgentStore.getState().queue).toEqual([]);
    });

    it("says when the queue is full, and offers Send next when it's held", () => {
      useAgentStore.setState({ status: "thinking", statusDetail: null, draft: "one more" });
      for (let i = 0; i < 5; i++) useAgentStore.getState().enqueue({ text: `m${i}`, images: [], mentions: [] });
      const { unmount } = render(<Composer />);
      expect(screen.getByRole("button", { name: "Queue message" })).toBeDisabled();
      expect(screen.getByText(/the queue is full \(5\)/)).toBeInTheDocument();
      unmount();
      useAgentStore.setState({ status: "idle", queuePaused: true, draft: "" });
      render(<Composer />);
      fireEvent.click(screen.getByRole("button", { name: "Send next" }));
      expect(controller.resumeQueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("editing the last message (Phase 8c)", () => {
    it("↑ in an empty box starts editing; with text in it, ↑ is left alone", () => {
      useAgentStore.setState({ status: "idle", statusDetail: null });
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(controller.startEditingLastMessage).toHaveBeenCalledTimes(1);
      fireEvent.change(input, { target: { value: "x" } });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(controller.startEditingLastMessage).toHaveBeenCalledTimes(1);
    });

    it("says it's editing, names the edits it reverts, and sends the edit", () => {
      controller.lastTurnEdits.mockReturnValue(["e1", "e2"]);
      useAgentStore.setState({ status: "idle", statusDetail: null, draft: "trim the intro", editingMessageId: "u2" });
      render(<Composer />);
      expect(screen.getByText(/Editing your last message · Esc to cancel · its 2 edits are reverted/)).toBeInTheDocument();
      fireEvent.keyDown(screen.getByLabelText("Message the agent"), { key: "Enter" });
      expect(controller.sendEditedMessage).toHaveBeenCalledWith("trim the intro", [], []);
      expect(controller.submitMessage).not.toHaveBeenCalled();
      expect(useAgentStore.getState().editingMessageId).toBeNull();
    });

    it("Escape cancels, and so does emptying the box", () => {
      useAgentStore.setState({ status: "idle", statusDetail: null, draft: "trim", editingMessageId: "u2" });
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(controller.cancelEditing).toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "" } });
      expect(useAgentStore.getState().editingMessageId).toBeNull();
    });
  });

  describe("images (Phase 8g)", () => {
    beforeEach(() => useAgentStore.setState({ status: "idle", statusDetail: null }));

    it("takes pasted images, shows them, and sends them, even without words", async () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      paste(input, [png("frame.png")]);
      expect(await screen.findByRole("img", { name: "frame.png" })).toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(controller.submitMessage).toHaveBeenCalledWith("", [expect.objectContaining({ id: "frame.png", mime: "image/png" })], []);
      expect(useAgentStore.getState().pendingImages).toEqual([]);
    });

    it("removes an image with its button, or the last one with Backspace in an empty box", async () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      paste(input, [png("a.png"), png("b.png"), png("c.png")]);
      await waitFor(() => expect(useAgentStore.getState().pendingImages).toHaveLength(3));
      fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
      fireEvent.keyDown(input, { key: "Backspace" });
      expect(useAgentStore.getState().pendingImages.map((i) => i.name)).toEqual(["b.png"]);
    });

    it("keeps at most four, and says what was left out", async () => {
      render(<Composer />);
      paste(screen.getByLabelText("Message the agent"), [png("1.png"), png("broken.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png")]);
      expect(await screen.findByRole("alert")).toHaveTextContent("broken.png couldn't be read as an image. At most 4 images can go with one message");
      expect(useAgentStore.getState().pendingImages).toHaveLength(4);
      expect(screen.getByRole("button", { name: "Add images" })).toBeDisabled();
    });

    it("puts the images back when the message couldn't be sent", async () => {
      controller.submitMessage.mockResolvedValueOnce(false);
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      paste(input, [png("frame.png")]);
      await screen.findByRole("img", { name: "frame.png" });
      fireEvent.change(input, { target: { value: "what's this?" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(useAgentStore.getState().pendingImages).toHaveLength(1));
      expect(useAgentStore.getState().draft).toBe("what's this?");
    });
  });

  describe("saved prompts (Phase 8h)", () => {
    beforeEach(() => {
      useAgentStore.setState({ status: "idle", statusDetail: null });
      usePromptStore.setState({
        prompts: [
          { id: "p1", name: "rough-cut", body: "Cut the interviews about {{topic}} into a draft." },
          { id: "p2", name: "find-silences", body: "Find the silences." },
        ],
      });
    });

    it("lists prompts after a /, filtered as you type", () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      fireEvent.change(input, { target: { value: "/" } });
      expect(screen.getAllByRole("option")).toHaveLength(2);
      fireEvent.change(input, { target: { value: "/sil" } });
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["/find-silencesFind the silences."]);
      fireEvent.change(input, { target: { value: "/sil and more" } });
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("chooses with the arrows and puts the prompt in the box on Enter, its blank selected, without sending", () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/" } });
      expect(input).toHaveAttribute("aria-activedescendant", expect.stringContaining("p1"));
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(controller.submitMessage).not.toHaveBeenCalled();
      expect(input.value).toBe("Cut the interviews about {{topic}} into a draft.");
      expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("{{topic}}");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("Tab picks too, and Escape closes the list and leaves the text", () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/find" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(input.value).toBe("/find");
      fireEvent.change(input, { target: { value: "/fin" } });
      fireEvent.keyDown(input, { key: "Tab" });
      expect(input.value).toBe("Find the silences.");
    });
  });

  describe("@-mentions (Phase 11c)", () => {
    beforeEach(async () => {
      const { initialHosts, useNleStateStore } = await import("../../store/useNleStateStore");
      const { nleState } = await import("../../test/nleFixtures");
      const hosts = initialHosts();
      hosts.resolve = nleState("resolve", { timelines: ["Main", "Selects"], timeline: null });
      useNleStateStore.setState({ hosts, preferredHost: "auto" });
      useAgentStore.setState({ status: "idle", statusDetail: null });
    });

    it("lists what can be mentioned after an @, inserts it at the caret, and sends it with the message", () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Copy @Sel", selectionStart: 9 } });
      expect(screen.getByRole("listbox", { name: "Mention" })).toBeInTheDocument();
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Selects"]);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe("Copy @Selects ");
      expect(useAgentStore.getState().draftMentions).toEqual([{ kind: "timeline", label: "Selects", ref: "Selects" }]);
      expect(controller.submitMessage).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "Copy @Selects please", selectionStart: 20 } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(controller.submitMessage).toHaveBeenCalledWith("Copy @Selects please", [], [{ kind: "timeline", label: "Selects", ref: "Selects" }]);
    });

    it("closes on Escape and when the caret leaves the @word", () => {
      render(<Composer />);
      const input = screen.getByLabelText("Message the agent");
      fireEvent.change(input, { target: { value: "@", selectionStart: 1 } });
      expect(screen.getAllByRole("option")).toHaveLength(2);
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.change(input, { target: { value: "@M and", selectionStart: 6 } });
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});
