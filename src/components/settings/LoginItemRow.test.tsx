import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ getOpenAtLogin: vi.fn(), setOpenAtLogin: vi.fn() }));
vi.mock("../../lib/ipc", () => ipc);

import { LoginItemRow } from "./LoginItemRow";

const box = () => screen.getByRole("checkbox", { name: /Open at login/ });

describe("LoginItemRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the setting and turns it on", async () => {
    ipc.getOpenAtLogin.mockResolvedValue(false);
    ipc.setOpenAtLogin.mockImplementation(async (on: boolean) => on);
    render(<LoginItemRow />);
    await waitFor(() => expect(box()).toBeEnabled());
    expect(box()).not.toBeChecked();
    fireEvent.click(box());
    expect(ipc.setOpenAtLogin).toHaveBeenCalledWith(true);
    await waitFor(() => expect(box()).toBeChecked());
  });

  it("stays off and says why in a dev build", async () => {
    ipc.getOpenAtLogin.mockRejectedValue("Only the installed app can open at login (npm run install-app).");
    render(<LoginItemRow />);
    expect(await screen.findByText("Only the installed app can open at login (npm run install-app).")).toBeInTheDocument();
    expect(box()).toBeDisabled();
    expect(box()).not.toBeChecked();
  });

  it("goes back and shows the error when it can't be changed", async () => {
    ipc.getOpenAtLogin.mockResolvedValue(true);
    ipc.setOpenAtLogin.mockRejectedValue(new Error("Permission denied"));
    render(<LoginItemRow />);
    await waitFor(() => expect(box()).toBeChecked());
    fireEvent.click(box());
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(box()).toBeChecked();
  });
});
