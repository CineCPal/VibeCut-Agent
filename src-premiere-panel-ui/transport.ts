import { BROLL_PANEL_VERSION, type PanelAction, type PanelBrollFile } from "../src/types/brollPanel";

/**
 * How the panel reaches VibeCut Agent (PLAN.md, "Phase 5b"), after VibeCut's src-host-panel transport:
 * files in `~/Library/Application Support/VibeCut Agent/host-bridge/broll/premiere/`, read and written
 * with CEP's Node `fs`.
 */
export interface FileOps {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeDir(path: string): Promise<void>;
}

export interface Transport {
  /** `broll.json`, or null when the app hasn't written it yet. */
  readBroll(): Promise<PanelBrollFile | null>;
  /** A shot's picture from `thumbs/` (a `data:` URL), or null. Only names the app gave are read. */
  readThumb(name: string): Promise<string | null>;
  /** When the app last stamped `agent-alive.json` (ms since epoch), or null. */
  agentAliveAt(): Promise<number | null>;
  /** Writes one action to the inbox (to a hidden name first, then renamed into place). */
  send(action: PanelAction): Promise<void>;
  /** Stamps `panel-alive.json` (and makes the folder, which tells the app a panel exists). */
  heartbeat(): Promise<void>;
  /** Fills an HTML drag with a shot's file: CEP hands Premiere a real file drag. */
  fillDrag?: (path: string, data: DataTransfer) => boolean;
}

export const panelDir = (home: string) => `${home}/Library/Application Support/VibeCut Agent/host-bridge/broll/premiere`;

/** The app is running if it stamped its heartbeat this recently. */
export const AGENT_STALE_MS = 4000;

export function newActionId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function fileTransport(dir: string, ops: FileOps, extras: Pick<Transport, "fillDrag"> = {}): Transport {
  let ready: Promise<void> | null = null;
  const ensureDirs = () =>
    (ready ??= ops.makeDir(`${dir}/inbox`).catch((error) => {
      ready = null;
      throw error;
    }));
  return {
    ...extras,
    async readBroll() {
      const text = await ops.readText(`${dir}/broll.json`);
      if (!text) return null;
      try {
        const file = JSON.parse(text) as PanelBrollFile;
        return file && file.version === BROLL_PANEL_VERSION && Array.isArray(file.shots) ? file : null;
      } catch {
        // Caught mid-write; the next read gets it whole.
        return null;
      }
    },
    async readThumb(name) {
      if (!/^s\d{1,18}\.txt$/.test(name)) return null;
      const text = await ops.readText(`${dir}/thumbs/${name}`);
      return text && text.startsWith("data:image/") ? text : null;
    },
    async agentAliveAt() {
      const text = await ops.readText(`${dir}/agent-alive.json`);
      if (!text) return null;
      try {
        const at = (JSON.parse(text) as { at?: unknown }).at;
        return typeof at === "number" ? at : null;
      } catch {
        return null;
      }
    },
    async send(action) {
      await ensureDirs();
      const tmp = `${dir}/inbox/.${action.id}.json.tmp`;
      await ops.writeText(tmp, JSON.stringify(action));
      await ops.rename(tmp, `${dir}/inbox/${action.id}.json`);
    },
    async heartbeat() {
      await ensureDirs();
      await ops.writeText(`${dir}/panel-alive.json`, JSON.stringify({ at: Date.now() }));
    },
  };
}
