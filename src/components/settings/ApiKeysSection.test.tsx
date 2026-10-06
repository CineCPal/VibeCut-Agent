import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ setApiKey: vi.fn(), removeApiKey: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { ApiKeysSection } from "./ApiKeysSection";
import { useSystemStore } from "../../store/useSystemStore";
import type { KeyStatus } from "../../types/system";

const status = (over: Partial<KeyStatus> = {}): KeyStatus => ({ gemini: false, anthropic: false, geminiSource: null, anthropicSource: null, huggingface: false, huggingfaceSource: null, ...over });

describe("ApiKeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStore.setState({ keys: status() });
  });

  it("saves a pasted key in the Keychain, clears the field and never shows the key", async () => {
    ipc.setApiKey.mockResolvedValue(status({ gemini: true, geminiSource: "keychain" }));
    render(<ApiKeysSection />);
    const field = screen.getByLabelText("Gemini API key");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "AIza-secret-123" } });
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]));
    expect(ipc.setApiKey).toHaveBeenCalledWith("gemini", "AIza-secret-123");
    expect(field).toHaveValue("");
    expect(screen.getByText("In the Keychain")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saved in the Keychain");
    expect(document.body.textContent).not.toContain("AIza-secret-123");
    expect(useSystemStore.getState().keys?.gemini).toBe(true);
  });

  it("shows why a key was refused", async () => {
    ipc.setApiKey.mockRejectedValue(new Error("An API key is one word, with no spaces or line breaks"));
    render(<ApiKeysSection />);
    fireEvent.change(screen.getByLabelText("Anthropic (Claude) API key"), { target: { value: "two words" } });
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]));
    expect(screen.getByRole("alert")).toHaveTextContent("one word");
  });

  it("removes a Keychain key, and says when the environment takes precedence", async () => {
    useSystemStore.setState({ keys: status({ gemini: true, geminiSource: "keychain", anthropic: true, anthropicSource: "environment", huggingface: false, huggingfaceSource: null }) });
    ipc.removeApiKey.mockResolvedValue(status({ anthropic: true, anthropicSource: "environment", huggingface: false, huggingfaceSource: null }));
    render(<ApiKeysSection />);
    expect(screen.getByText(/ANTHROPIC_API_KEY is set where the app started/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove the Anthropic (Claude) key from the Keychain" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove the Gemini key from the Keychain" })));
    expect(ipc.removeApiKey).toHaveBeenCalledWith("gemini");
    expect(screen.getByText("Missing")).toBeInTheDocument();
  });

  it("can't save an empty key", () => {
    render(<ApiKeysSection />);
    expect(screen.getAllByRole("button", { name: "Save" })[0]).toBeDisabled();
  });
});
