import { beforeEach, describe, expect, it } from "vitest";
import { initialHosts, selectActiveHost, useNleStateStore } from "./useNleStateStore";
import { nleState } from "../test/nleFixtures";

const store = () => useNleStateStore.getState();

describe("useNleStateStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
  });

  it("starts with both editors connecting and none active", () => {
    expect(store().hosts.premiere.status).toBe("connecting");
    expect(store().hosts.resolve.status).toBe("connecting");
    expect(selectActiveHost(store())).toBeNull();
  });

  it("applies pushed states per host", () => {
    store().applyState(nleState("resolve", { project: "Promo", timeline: "Cut v3" }));
    expect(store().hosts.resolve).toMatchObject({ status: "connected", project: "Promo", timeline: "Cut v3" });
    expect(store().hosts.premiere.status).toBe("connecting");
  });

  it("ignores a state older than the one it has", () => {
    store().applyState(nleState("premiere", { status: "disconnected", changedAt: 20 }));
    store().applyState(nleState("premiere", { status: "connected", changedAt: 15 }));
    expect(store().hosts.premiere.status).toBe("disconnected");
  });

  it("picks the preferred host when it is connected, else the first connected one", () => {
    store().applyState(nleState("premiere"));
    store().applyState(nleState("resolve"));
    expect(selectActiveHost(store())).toBe("premiere");

    store().setPreferredHost("resolve");
    expect(selectActiveHost(store())).toBe("resolve");

    store().applyState(nleState("resolve", { status: "disconnected", changedAt: 11 }));
    expect(selectActiveHost(store())).toBe("premiere");
  });

  it("persists only the preferred host", () => {
    store().applyState(nleState("premiere"));
    store().setPreferredHost("premiere");
    const saved = JSON.parse(localStorage.getItem("vibecut-agent.nle") ?? "{}");
    expect(saved.state).toEqual({ preferredHost: "premiere" });
  });
});
