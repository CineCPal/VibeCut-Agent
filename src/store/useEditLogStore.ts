import { create } from "zustand";
import type { EditEntry } from "../types/edits";
import type { SavedEditLog } from "../types/history";
import type { NleHost } from "../types/nle";

/** The newest entries kept in the saved log (reverted ones go first when it's over). */
export const KEEP_EDIT_ENTRIES = 500;

/**
 * The direct edits made, with what each changed, for Revert (ported from VibeCut's useConnectStore edit
 * log). Since Phase 8a it's saved in the app's data folder (lib/agent/chatHistory.ts) and loaded at
 * launch, so Revert survives a restart; each request's backup copy in the editor is still the second way
 * back. It's one log for the app, not per chat: Revert follows the timeline, not the conversation.
 */
export interface EditLogState {
  entries: EditEntry[];
  /** "<step>|<host>|<timeline>" -> the backup made for that request. */
  backups: Record<string, string>;
  /** Per editor: clip ids a revert or a replacement changed, old -> new, so older changes follow them. */
  restoredIds: Record<NleHost, Record<string, string>>;
  /** The lowest number the next entry's id ("e<n>") may take: set from the saved log, so ids aren't
   * reused across restarts even after old entries were trimmed. */
  floorSeq: number;
  log: (entry: Omit<EditEntry, "id" | "at">) => EditEntry;
  setBackup: (key: string, name: string) => void;
  addRestoredIds: (host: NleHost, ids: Record<string, string>) => void;
  markReverted: (id: string, info: NonNullable<EditEntry["reverted"]>) => void;
  /** Loads the saved log at launch, ahead of anything logged since; its entries are `fromEarlierRun`. */
  hydrate: (saved: SavedEditLog) => void;
}

const seqOf = (id: string) => (/^e(\d+)$/.exec(id) ? Number(id.slice(1)) : 0);

export const useEditLogStore = create<EditLogState>()((set, get) => ({
  entries: [],
  backups: {},
  restoredIds: { premiere: {}, resolve: {} },
  floorSeq: 1,
  log: (entry) => {
    const { entries, floorSeq } = get();
    const logged: EditEntry = { ...entry, id: `e${Math.max(floorSeq, ...entries.map((e) => seqOf(e.id) + 1))}`, at: Date.now() };
    set((s) => ({ entries: [...s.entries, logged] }));
    return logged;
  },
  setBackup: (key, name) => set((s) => ({ backups: { ...s.backups, [key]: name } })),
  addRestoredIds: (host, ids) =>
    set((s) => ({ restoredIds: { ...s.restoredIds, [host]: { ...s.restoredIds[host], ...ids } } })),
  markReverted: (id, info) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, reverted: info } : e)) })),
  hydrate: (saved) =>
    set((s) => {
      const taken = new Set(s.entries.map((e) => e.id));
      const earlier = saved.entries.filter((e) => !taken.has(e.id)).map((e) => ({ ...e, fromEarlierRun: true }));
      const entries = [...earlier, ...s.entries];
      return {
        entries,
        backups: { ...saved.backups, ...s.backups },
        restoredIds: {
          premiere: { ...saved.restoredIds.premiere, ...s.restoredIds.premiere },
          resolve: { ...saved.restoredIds.resolve, ...s.restoredIds.resolve },
        },
        floorSeq: Math.max(s.floorSeq, saved.nextSeq ?? 1, ...entries.map((e) => seqOf(e.id) + 1)),
      };
    }),
}));

/** Every unreverted entry of the newest request that has one. */
export function lastEditStep(entries: EditEntry[] = useEditLogStore.getState().entries): string[] {
  const live = entries.filter((e) => !e.reverted);
  const step = live[live.length - 1]?.step;
  return step ? live.filter((e) => e.step === step).map((e) => e.id) : [];
}

/** At most `keep` entries: the oldest reverted ones go first, then the oldest. Order is kept. */
export function trimEntries(entries: EditEntry[], keep = KEEP_EDIT_ENTRIES): EditEntry[] {
  let over = entries.length - keep;
  if (over <= 0) return entries;
  const dropped = new Set<string>();
  for (const e of entries) {
    if (over === 0) break;
    if (e.reverted) {
      dropped.add(e.id);
      over--;
    }
  }
  for (const e of entries) {
    if (over === 0) break;
    if (!dropped.has(e.id)) {
      dropped.add(e.id);
      over--;
    }
  }
  return entries.filter((e) => !dropped.has(e.id));
}

/** The log as it's saved: trimmed, with backups only for requests still in it. */
export function savedEditLog(state: Pick<EditLogState, "entries" | "backups" | "restoredIds" | "floorSeq"> = useEditLogStore.getState()): SavedEditLog {
  const entries = trimEntries(state.entries).map(({ fromEarlierRun: _earlier, ...e }) => e);
  const steps = new Set(entries.map((e) => e.step));
  const backups = Object.fromEntries(Object.entries(state.backups).filter(([key]) => steps.has(key.split("|")[0])));
  const nextSeq = Math.max(state.floorSeq, ...state.entries.map((e) => seqOf(e.id) + 1));
  return { version: 1, entries, backups, restoredIds: state.restoredIds, nextSeq };
}

/** A saved log read back from disk, checked; null when it isn't one. */
export function parseSavedEditLog(value: unknown): SavedEditLog | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.entries)) return null;
  const entries = v.entries.filter(
    (e): e is EditEntry =>
      typeof e === "object" && e !== null && typeof (e as EditEntry).id === "string" && typeof (e as EditEntry).step === "string" &&
      ((e as EditEntry).host === "premiere" || (e as EditEntry).host === "resolve") && typeof (e as EditEntry).timeline === "string" &&
      Array.isArray((e as EditEntry).changes),
  );
  const record = (x: unknown): Record<string, string> =>
    typeof x === "object" && x !== null ? Object.fromEntries(Object.entries(x).filter(([, s]) => typeof s === "string")) as Record<string, string> : {};
  const restored = (typeof v.restoredIds === "object" && v.restoredIds !== null ? v.restoredIds : {}) as Record<string, unknown>;
  return {
    version: 1,
    entries,
    backups: record(v.backups),
    restoredIds: { premiere: record(restored.premiere), resolve: record(restored.resolve) },
    ...(typeof v.nextSeq === "number" && Number.isFinite(v.nextSeq) ? { nextSeq: v.nextSeq } : {}),
  };
}
