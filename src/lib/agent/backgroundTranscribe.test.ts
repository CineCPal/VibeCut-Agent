import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ startSidecar: vi.fn(async () => undefined) }));
vi.mock("../ipc", () => ipc);
vi.mock("../notify", () => ({ notifyAway: vi.fn() }));
const awareness = vi.hoisted(() => ({ forgetTranscriptStatus: vi.fn() }));
vi.mock("./awareness", () => awareness);

import { backgroundProgress, finishedMessage, resetBackgroundTranscriptions, transcribeInBackground } from "./backgroundTranscribe";
import { useSidecarStore } from "../../store/useSidecarStore";

const LONG = "/Volumes/Shoot/gratitude_03.mp4";

beforeEach(() => {
  vi.clearAllMocks();
  resetBackgroundTranscriptions();
  useSidecarStore.setState({ jobs: [] });
});

describe("background transcription", () => {
  it("answers at once, reports progress while it runs, and tells the chat when it's done", async () => {
    const delivered: string[] = [];
    const id = await transcribeInBackground([LONG], { model: "m", diarize: true, format: "txt", force: true }, async (t) => delivered.push(t));
    expect(ipc.startSidecar).toHaveBeenCalledWith(id, "transcribe", { model: "m", diarize: true, format: "txt", force: true, videos: [LONG], background: true });
    expect(backgroundProgress(LONG)).toBe("starting");
    const store = useSidecarStore.getState();
    store.applyEvent(id, { type: "progress", done: 0.4, total: 1, fraction: 0.4, phase: "transcribe", detail: "gratitude_03.mp4: Transcribing… 40%" } as never);
    expect(backgroundProgress(LONG)).toMatch(/^40%/);
    store.applyEvent(id, { type: "result", files: [{ path: LONG, fromCache: false, speakers: ["Speaker 1", "Speaker 2"], segmentCount: 754 }], failed: [] } as never);
    store.applyExit({ jobId: id, code: 0, cancelled: false, message: null } as never);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toBe(
      "[App: background transcription finished] Transcribed gratitude_03.mp4 (754 lines, 2 speaker(s)). Continue with what you were doing when you started it.",
    );
    expect(awareness.forgetTranscriptStatus).toHaveBeenCalledWith([LONG]);
    expect(backgroundProgress(LONG)).toBeNull();
  });

  it("says why when it failed or was stopped", () => {
    expect(finishedMessage([LONG], { status: "failed", error: "ffmpeg failed", result: null } as never)).toBe(
      "[App: background transcription failed] gratitude_03.mp4: ffmpeg failed.",
    );
    expect(finishedMessage([LONG], { status: "cancelled", error: null, result: null } as never)).toContain("it was stopped");
  });
});
