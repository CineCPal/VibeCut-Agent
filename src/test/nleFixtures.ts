import type { NleHost, NleState } from "../types/nle";

/** A host state as Rust sends it, with overrides. */
export function nleState(host: NleHost, over: Partial<NleState> = {}): NleState {
  return {
    host,
    status: "connected",
    message: null,
    product: host === "premiere" ? "Adobe Premiere Pro" : "DaVinci Resolve Studio",
    version: "1",
    project: "Doc",
    timeline: "Main",
    timelines: ["Main"],
    reason: "connected",
    changedAt: 10,
    ...over,
  };
}
