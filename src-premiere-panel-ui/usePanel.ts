import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelAction, PanelBrollFile } from "../src/types/brollPanel";
import { AGENT_STALE_MS, newActionId, type Transport } from "./transport";

const READ_EVERY_MS = 250;
const BEAT_EVERY_MS = 1000;

/** Browsing: these don't wait for an answer, so they never hold the other buttons (VibeCut's QUIET). */
const QUIET: ReadonlySet<PanelAction["type"]> = new Set(["hello", "broll_open", "broll_expand", "broll_scope", "broll_clear_scope", "broll_search", "broll_more", "broll_pool"]);

/** Distributes Omit over the action union, so each action keeps its own fields. */
type ActionBody = PanelAction extends infer A ? (A extends PanelAction ? Omit<A, "id"> : never) : never;

export interface PanelView {
  file: PanelBrollFile | null;
  /** VibeCut Agent stamped its heartbeat recently. */
  agentRunning: boolean;
  /** A Source, Import or Place written but not answered yet. */
  pending: string | null;
  /** Writing to the inbox failed. */
  writeError: string | null;
  act: (action: ActionBody) => void;
}

/** Reads the app's `broll.json` for this panel, stamps the panel's heartbeat, and writes its actions
 * (VibeCut's usePanel + useBroll, merged: this panel is the B-roll tab only). */
export function usePanel(transport: Transport): PanelView {
  const [file, setFile] = useState<PanelBrollFile | null>(null);
  const [aliveAt, setAliveAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastPublished = useRef(0);

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const [next, alive] = await Promise.all([transport.readBroll(), transport.agentAliveAt()]);
        if (stopped) return;
        setAliveAt(alive);
        setNow(Date.now());
        if (next && next.publishedAt !== lastPublished.current) {
          lastPublished.current = next.publishedAt;
          setFile(next);
        }
      } catch {
        // Unreadable for a moment; the next read tries again.
      }
    };
    const beat = () => transport.heartbeat().catch(() => {});
    void beat();
    void read();
    // Tells the app a panel is here, so it publishes at once and opens the Library.
    void transport.send({ id: newActionId(), type: "hello" }).catch(() => {});
    const reader = setInterval(read, READ_EVERY_MS);
    const beater = setInterval(beat, BEAT_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(reader);
      clearInterval(beater);
    };
  }, [transport]);

  // An action is answered once the app publishes a notice for it.
  useEffect(() => {
    if (pending && file?.notice?.actionId === pending) setPending(null);
  }, [file, pending]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 15000);
    return () => clearTimeout(timer);
  }, [pending]);

  const act = useCallback(
    (body: ActionBody) => {
      const action = { ...body, id: newActionId() } as PanelAction;
      if (!QUIET.has(action.type)) setPending(action.id);
      setWriteError(null);
      transport.send(action).catch((error: unknown) => {
        if (!QUIET.has(action.type)) setPending(null);
        setWriteError(error instanceof Error ? error.message : String(error));
      });
    },
    [transport],
  );

  return { file, agentRunning: aliveAt !== null && now - aliveAt < AGENT_STALE_MS, pending, writeError, act };
}
