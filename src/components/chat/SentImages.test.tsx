import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  loadChatAttachment: vi.fn(async (_chat: string, id: string) => {
    if (id === "gone") throw new Error("That image is gone");
    return { mime: "image/png", data: "QUJD" };
  }),
  saveChatAttachment: vi.fn(),
  nleCall: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

import { MessageList } from "./MessageList";
import { useAgentStore } from "../../store/useAgentStore";

describe("sent images (Phase 8g)", () => {
  it("shows a message's images from beside its chat, and says when one is gone", async () => {
    useAgentStore.setState({ chatId: "c1" });
    const attachment = (id: string) => ({ id, name: `${id}.png`, mime: "image/png", width: 4, height: 3, bytes: 3 });
    render(<MessageList messages={[{ id: "u", role: "user", text: "look", createdAt: 1, attachments: [attachment("i1"), attachment("gone")] }]} activity={null} />);
    expect(await screen.findByRole("img", { name: "i1.png" })).toHaveAttribute("src", "data:image/png;base64,QUJD");
    expect(await screen.findByText("gone.png (no longer on disk)")).toBeInTheDocument();
    expect(ipc.loadChatAttachment).toHaveBeenCalledWith("c1", "i1");
  });
});
