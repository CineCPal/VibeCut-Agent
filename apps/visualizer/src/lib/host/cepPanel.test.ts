import { describe, expect, it, vi } from "vitest";
import { aliveStamp, PANEL_POLL_MS, panelLocation, parseGatewayFile, startPanelLoop, type PanelLoopHost } from "./cepPanel";
import { resolveHostAdapter } from "./runtimeHostAdapter";

describe("the Premiere panel's gateway file", () => {
  const file = (body: object) => JSON.stringify(body);

  it("reads a loopback gateway and its key", () => {
    expect(parseGatewayFile(file({ url: "http://127.0.0.1:18765", panel_key: "k1", pid: 4 }))).toEqual({
      url: "http://127.0.0.1:18765",
      panelKey: "k1",
    });
    expect(parseGatewayFile(file({ url: "http://localhost:18799/", panel_key: "k" }))?.url).toBe("http://localhost:18799");
  });

  it("refuses anything else: no file, bad JSON, no key, another host or scheme", () => {
    expect(parseGatewayFile(null)).toBeNull();
    expect(parseGatewayFile("{")).toBeNull();
    expect(parseGatewayFile(file({ url: "http://127.0.0.1:18765" }))).toBeNull();
    expect(parseGatewayFile(file({ url: "http://127.0.0.1:18765", panel_key: "" }))).toBeNull();
    expect(parseGatewayFile(file({ url: "http://192.168.1.4:18765", panel_key: "k" }))).toBeNull();
    expect(parseGatewayFile(file({ url: "https://127.0.0.1:18765", panel_key: "k" }))).toBeNull();
    expect(parseGatewayFile(file({ url: "not a url", panel_key: "k" }))).toBeNull();
  });

  it("hands the host adapter the panel's mode, the gateway and the key", () => {
    const adapter = resolveHostAdapter(panelLocation({ url: "http://127.0.0.1:18765", panelKey: "a b&c" }));
    expect(adapter.mode).toBe("embedded_cep");
    expect(adapter.compact).toBe(true);
    expect(adapter.httpBase).toBe("http://127.0.0.1:18765");
    expect(adapter.token).toBe("a b&c");
    expect(adapter.wsUrl).toBe("ws://127.0.0.1:18765/ws/v1/telemetry?token=a%20b%26c");
  });

  it("stamps its heartbeat in seconds, as the app reads it", () => {
    expect(JSON.parse(aliveStamp(1_500, 42))).toEqual({ time: 1.5, pid: 42 });
  });
});

describe("the Premiere panel's loop", () => {
  /** A fake CEP: gateway.json's text, and the intervals Node would keep running. */
  function host(scope: PanelLoopHost["scope"], file: { text: string | null }) {
    const timers = new Map<number, () => void>();
    let next = 1;
    const onGateway = vi.fn();
    const stampAlive = vi.fn();
    const h: PanelLoopHost = {
      readGateway: () => file.text,
      stampAlive,
      onGateway,
      setInterval: (callback, ms) => {
        expect(ms).toBe(PANEL_POLL_MS);
        timers.set(next, callback);
        return next++;
      },
      clearInterval: (handle) => timers.delete(handle as number),
      scope,
    };
    return { h, timers, onGateway, stampAlive, tick: () => [...timers.values()].forEach((t) => t()) };
  }

  it("shows the gateway at the start, and again in place when it changes, never reloading", () => {
    const file = { text: '{"url":"a"}' as string | null };
    const { h, onGateway, stampAlive, tick } = host({}, file);
    startPanelLoop(h);
    expect(onGateway).toHaveBeenCalledWith('{"url":"a"}');
    tick();
    tick();
    expect(onGateway).toHaveBeenCalledTimes(1);
    expect(stampAlive).toHaveBeenCalledTimes(3);
    file.text = '{"url":"b"}';
    tick();
    tick();
    expect(onGateway.mock.calls.map((c) => c[0])).toEqual(['{"url":"a"}', '{"url":"b"}']);
    file.text = null;
    tick();
    expect(onGateway).toHaveBeenLastCalledWith(null);
  });

  it("stops the loop a previous page left running, so only one ever runs", () => {
    const scope: PanelLoopHost["scope"] = {};
    const file = { text: "old" as string | null };
    const first = host(scope, file);
    const firstStop = vi.fn();
    startPanelLoop({ ...first.h, onStop: firstStop });
    file.text = "new";
    // The page reloaded, but Node kept the first page's interval: the second page stops it, and what it started.
    const second = host(scope, file);
    startPanelLoop(second.h);
    expect(first.timers.size).toBe(0);
    expect(firstStop).toHaveBeenCalledTimes(1);
    first.tick();
    second.tick();
    expect(first.onGateway).toHaveBeenCalledTimes(1);
    expect(second.onGateway).toHaveBeenCalledTimes(1);
    expect(scope.__vibecutStudioLoop).toBeDefined();
  });

  it("stops cleanly", () => {
    const scope: PanelLoopHost["scope"] = {};
    const { h, timers } = host(scope, { text: null });
    const onStop = vi.fn();
    const stop = startPanelLoop({ ...h, onStop });
    stop();
    expect(timers.size).toBe(0);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(scope.__vibecutStudioLoop).toBeUndefined();
  });
});
