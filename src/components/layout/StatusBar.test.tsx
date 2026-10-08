import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { useAgentStore } from "../../store/useAgentStore";
import { AI_CHOICES } from "../../types/agent";

describe("StatusBar", () => {
  beforeEach(() => useAgentStore.setState({ status: "idle", aiChoice: AI_CHOICES[0].id }));

  it("shows the agent's state and model at the bottom of the window", () => {
    render(<StatusBar />);
    const bar = screen.getByRole("contentinfo", { name: "Agent status" });
    expect(screen.getByRole("status")).toHaveTextContent("Ready");
    expect(bar).toHaveTextContent(`Ready·${AI_CHOICES[0].label}`);
  });

  it("follows the agent's state and the chosen model", () => {
    render(<StatusBar />);
    act(() => useAgentStore.setState({ status: "thinking", aiChoice: AI_CHOICES[1].id }));
    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(screen.getByRole("contentinfo")).toHaveTextContent(AI_CHOICES[1].label);
  });
});
