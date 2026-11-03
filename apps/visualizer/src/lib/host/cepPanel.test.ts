import { describe, expect, it } from "vitest";
import { aliveStamp, panelLocation, parseGatewayFile } from "./cepPanel";
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
