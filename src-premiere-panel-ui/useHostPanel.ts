import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelBrollFile } from "../src/types/brollPanel";
import type { HostAnalyzerFile, HostChatAction, HostKanbanFile, HostPanelStateFile } from "../src/types/hostPanel";
import { AGENT_STALE_MS, newActionId, type Transport } from "./transport";

const READ_EVERY_MS = 250;
const BEAT_EVERY_MS = 1000;
/** A held action lets go after this long, answered or not. */
const PENDING_MS = 15000;

/** The actions the app answers with a notice; the rest show their effect in the next `state.json`. */
const ANSWERED: ReadonlySet<HostChatAction["type"]> = new Set([
  "revert",
  "draft_send",
  "draft_discard",
  "broll_import",
  "broll_source",
  "broll_place",
  "analyzer_place",
  "analyzer_source",
  "analyzer_export",
  "analyzer_build",
  "kanban_run",
  "kanban_run_wave",
  "kanban_seed_qc",
  "kanban_sync_markers",
  "kanban_create",
]);

/** Distributes Omit over the action union, so each action keeps its own fields. */
export type HostActionBody = HostChatAction extends infer A ? (A extends HostChatAction ? Omit<A, "id"> : never) : never;

export interface HostPanelView {
  state: HostPanelStateFile | null;
  broll: PanelBrollFile | null;
  analyzer: HostAnalyzerFile | null;
  /** `kanban.json`: the editor project's Kanban board (Phase 23). */
  kanban: HostKanbanFile | null;
  /** The app wrote another version's `state.json`: the panel needs updating (or the app does). */
  otherVersion: number | null;
  /** VibeCut Agent stamped its heartbeat recently. */
  agentRunning: boolean;
  /** An answered action written but not answered yet. */
  pending: string | null;
  /** Writing to the inbox failed. */
  writeError: string | null;
  act: (action: HostActionBody) => void;
}

/** Reads the app's `state.json` and `broll.json` for this panel, stamps the panel's heartbeat, and
 * writes its actions (the full panels' `usePanel`). */
export function useHostPanel(transport: Transport): HostPanelView {
  const [state, setState] = useState<HostPanelStateFile | null>(null);
  const [broll, setBroll] = useState<PanelBrollFile | null>(null);
  const [analyzer, setAnalyzer] = useState<HostAnalyzerFile | null>(null);
  const [kanban, setKanban] = useState<HostKanbanFile | null>(null);
  const [otherVersion, setOtherVersion] = useState<number | null>(null);
  const [aliveAt, setAliveAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const published = useRef({ state: 0, broll: 0, analyzer: 0, kanban: 0 });

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const [nextState, nextBroll, nextAnalyzer, nextKanban, alive] = await Promise.all([
          transport.readState(),
          transport.readBroll(),
          transport.readAnalyzer ? transport.readAnalyzer() : Promise.resolve(null),
          transport.readKanban ? transport.readKanban() : Promise.resolve(null),
          transport.agentAliveAt(),
        ]);
        if (stopped) return;
        setAliveAt(alive);
        setOtherVersion(transport.stateVersion?.() ?? null);
        if (nextAnalyzer && nextAnalyzer.publishedAt !== published.current.analyzer) {
          published.current.analyzer = nextAnalyzer.publishedAt;
          setAnalyzer(nextAnalyzer);
        }
        if (nextKanban && nextKanban.publishedAt !== published.current.kanban) {
          published.current.kanban = nextKanban.publishedAt;
          setKanban(nextKanban);
        }
        setNow(Date.now());
        if (nextState && nextState.publishedAt !== published.current.state) {
          published.current.state = nextState.publishedAt;
          setState(nextState);
        }
        if (nextBroll && nextBroll.publishedAt !== published.current.broll) {
          published.current.broll = nextBroll.publishedAt;
          setBroll(nextBroll);
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

  // An action is answered once the app publishes a notice for it, in either file.
  useEffect(() => {
    if (pending && [state?.notice, broll?.notice, analyzer?.notice, kanban?.notice].some((n) => n?.actionId === pending)) setPending(null);
  }, [state, broll, analyzer, kanban, pending]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const act = useCallback(
    (body: HostActionBody) => {
      const action = { ...body, id: newActionId() } as HostChatAction;
      const answered = ANSWERED.has(action.type);
      if (answered) setPending(action.id);
      setWriteError(null);
      transport.send(action).catch((error: unknown) => {
        if (answered) setPending(null);
        setWriteError(error instanceof Error ? error.message : String(error));
      });
    },
    [transport],
  );

  return { state, broll, analyzer, kanban, otherVersion, agentRunning: aliveAt !== null && now - aliveAt < AGENT_STALE_MS, pending, writeError, act };
}
