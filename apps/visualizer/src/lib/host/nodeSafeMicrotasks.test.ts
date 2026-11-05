import { afterEach, describe, expect, it, vi } from "vitest";
import { installNodeSafeMicrotasks } from "./nodeSafeMicrotasks";

/** A stand-in global scope, so the real one is left alone. */
function scope(node: boolean) {
  const nodeQueue = vi.fn();
  return { scope: { queueMicrotask: nodeQueue, ...(node ? { process: { versions: { node: "18.0.0" } } } : {}) } as unknown as typeof globalThis, nodeQueue };
}

describe("React kept off Node's queueMicrotask in CEP panels", () => {
  afterEach(() => vi.useRealTimers());

  it("replaces Node's queueMicrotask with the page's own queue when Node is in the page", async () => {
    const { scope: s, nodeQueue } = scope(true);
    expect(installNodeSafeMicrotasks(s)).toBe(true);
    expect(s.queueMicrotask).not.toBe(nodeQueue);
    const order: string[] = [];
    setTimeout(() => order.push("timeout"), 0);
    s.queueMicrotask(() => order.push("first"));
    s.queueMicrotask(() => order.push("second"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first", "second", "timeout"]);
    expect(nodeQueue).not.toHaveBeenCalled();
  });

  it("reports an error thrown in a callback instead of swallowing it", async () => {
    vi.useFakeTimers();
    const { scope: s } = scope(true);
    installNodeSafeMicrotasks(s);
    s.queueMicrotask(() => {
      throw new Error("boom");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => vi.runAllTimers()).toThrow("boom");
  });

  it("leaves queueMicrotask alone without Node", () => {
    const { scope: s, nodeQueue } = scope(false);
    expect(installNodeSafeMicrotasks(s)).toBe(false);
    expect(s.queueMicrotask).toBe(nodeQueue);
  });
});
