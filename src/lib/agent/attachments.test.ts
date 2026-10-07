import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  saveChatAttachment: vi.fn(async () => undefined),
  loadChatAttachment: vi.fn(async () => ({ mime: "image/jpeg", data: "QUJD" })),
}));
vi.mock("../ipc", () => ipc);

import { KEEP_AS_IS_BYTES, MAX_EDGE, attachmentUrl, clearAttachmentCache, imageFiles, resizePlan, saveImages } from "./attachments";
import type { PendingImage } from "../../types/agent";

describe("attachments (Phase 8g)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAttachmentCache();
  });

  it("keeps a small image as it is and shrinks a large one to the long-edge limit", () => {
    expect(resizePlan(1400, 900, 500_000, "image/png")).toEqual({ keep: true });
    expect(resizePlan(1920, 1080, 500_000, "image/png")).toEqual({ keep: false, scale: MAX_EDGE / 1920, type: "image/png" });
    expect(resizePlan(1200, 800, KEEP_AS_IS_BYTES + 1, "image/png")).toEqual({ keep: false, scale: 1, type: "image/png" });
    expect(resizePlan(4000, 3000, 2_000_000, "image/jpeg")).toEqual({ keep: false, scale: MAX_EDGE / 4000, type: "image/jpeg" });
    expect(resizePlan(1000, 5000, 100, "image/webp")).toEqual({ keep: false, scale: MAX_EDGE / 5000, type: "image/jpeg" });
  });

  it("picks the images out of pasted or dropped files", () => {
    const files = [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.txt", { type: "text/plain" })];
    expect(imageFiles(files).map((f) => f.name)).toEqual(["a.png"]);
    expect(imageFiles(null)).toEqual([]);
  });

  it("shows a sent image from memory, else reads it back from beside the chat", async () => {
    const image: PendingImage = { id: "i1", name: "i1.png", mime: "image/png", width: 1, height: 1, bytes: 3, data: "QUJD", dataUrl: "data:image/png;base64,QUJD" };
    await saveImages("c1", [image]);
    expect(ipc.saveChatAttachment).toHaveBeenCalledWith("c1", "i1", "image/png", "QUJD");
    expect(await attachmentUrl("c1", image)).toBe("data:image/png;base64,QUJD");
    expect(ipc.loadChatAttachment).not.toHaveBeenCalled();
    expect(await attachmentUrl("c2", image)).toBe("data:image/jpeg;base64,QUJD");
    expect(ipc.loadChatAttachment).toHaveBeenCalledWith("c2", "i1");
  });
});
