import { describe, expect, it } from "vitest";
import { resolveHostAdapter } from "./runtimeHostAdapter";

const at = (search: string, hostname = "studio.local", host = "studio.local:5173") => ({
  search,
  hostname,
  host,
  protocol: "http:",
});

describe("the host adapter", () => {
  it("connects a standalone page to its own host's gateway", () => {
    const a = resolveHostAdapter(at(""));
    expect(a.mode).toBe("standalone");
    expect(a.wsUrl).toBe("ws://studio.local:18765/ws/v1/telemetry");
    expect(a.source).toBe("gateway");
  });

  it("connects embedded hosts to loopback, and CEP gets the compact layout", () => {
    expect(resolveHostAdapter(at("?mode=embedded_tauri")).httpBase).toBe("http://127.0.0.1:18765");
    const cep = resolveHostAdapter(at("?mode=embedded_cep"));
    expect(cep.compact).toBe(true);
  });

  it("takes a gateway, a token, a trace and the mock source from the query", () => {
    const a = resolveHostAdapter(at("?gateway=http://10.0.0.5:18765/&token=a%20b&trace=trc_1&source=mock"));
    expect(a.httpBase).toBe("http://10.0.0.5:18765");
    expect(a.wsUrl).toBe("ws://10.0.0.5:18765/ws/v1/telemetry?token=a%20b");
    expect(a.sseUrl).toBe("http://10.0.0.5:18765/sse/v1/telemetry?trace_id=trc_1&token=a%20b");
    expect(a.traceId).toBe("trc_1");
    expect(a.source).toBe("mock");
    expect(resolveHostAdapter(at("?gateway=proxy")).wsUrl).toBe("ws://studio.local:5173/ws/v1/telemetry");
  });
});
