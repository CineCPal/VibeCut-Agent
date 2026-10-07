import { beforeEach, describe, expect, it } from "vitest";
import { availability, refreshAgentStatus } from "./availability";
import { useAgentStore } from "../../store/useAgentStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useSystemStore } from "../../store/useSystemStore";
import type { SessionStatus } from "../../types/sidecar";

const ready: SessionStatus = { state: "ready", version: "0.1.0", python: "3.14.0", message: null };

describe("availability", () => {
  it("waits for the sidecar and reports its failure", () => {
    expect(availability({ ...ready, state: "starting" }, { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null }, "gemini").status).toBe("offline");
    expect(availability({ ...ready, state: "stopped", message: "uv not found" }, null, "gemini")).toEqual({
      status: "error",
      detail: "uv not found",
    });
  });

  it("needs the chosen model's key", () => {
    expect(availability(ready, null, "gemini").detail).toBe("Checking API keys…");
    expect(availability(ready, { gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null }, "claude-opus-5-5")).toEqual({
      status: "offline",
      detail: "Add your Anthropic API key (ANTHROPIC_API_KEY) in Settings to use Claude Opus 5.5, or choose another model.",
    });
    expect(availability(ready, { gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null }, "gemini")).toEqual({ status: "idle", detail: null });
  });

  it("needs Claude Code installed and signed in for a subscription model, and no key", () => {
    const noKeys = { gemini: false, anthropic: false, geminiSource: null, anthropicSource: null, huggingface: false, huggingfaceSource: null };
    const code = { program: "/u/.local/bin/claude", programSaved: null, configDir: null, signedIn: true, email: "a@b.c", subscription: "pro", detail: null };
    expect(availability(ready, noKeys, "claude-code-sonnet-5-5", null)).toEqual({ status: "offline", detail: "Checking Claude Code…" });
    expect(availability(ready, noKeys, "claude-code-sonnet-5-5", code)).toEqual({ status: "idle", detail: null });
    const signedOut = { ...code, signedIn: false, detail: "Claude Code isn't signed in." };
    expect(availability(ready, noKeys, "claude-code-opus-5-5", signedOut)).toEqual({
      status: "offline",
      detail: "Claude Code isn't signed in. See Settings → Claude subscription, or choose another model.",
    });
    expect(availability(ready, noKeys, "claude-code-opus-5-5", { ...code, program: null, detail: "Not installed." }).status).toBe("offline");
    expect(availability(ready, noKeys, "claude-code-opus-5-5", { ...code, signedIn: null }).status).toBe("idle");
  });

  describe("refreshAgentStatus", () => {
    beforeEach(() => {
      useSidecarStore.setState({ session: ready });
      useSystemStore.setState({ keys: { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null } });
      useAgentStore.setState({ aiChoice: "gemini", status: "offline", statusDetail: "x" });
    });

    it("applies availability", () => {
      refreshAgentStatus();
      expect(useAgentStore.getState()).toMatchObject({ status: "idle", statusDetail: null });
    });

    it("leaves a running turn alone", () => {
      useAgentStore.setState({ status: "thinking" });
      useSidecarStore.setState({ session: { ...ready, state: "stopped" } });
      refreshAgentStatus();
      expect(useAgentStore.getState().status).toBe("thinking");
    });
  });
});
