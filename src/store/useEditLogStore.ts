import { create } from "zustand";
import type { EditEntry } from "../types/edits";
import type { NleHost } from "../types/nle";

/**
 * The direct edits made this session, with what each changed, for Revert (ported from VibeCut's
 * useConnectStore edit log). Kept in memory like VibeCut's: after a restart, each request's backup
 * copy in the editor is the way back.
 */
export interface EditLogState {
  entries: EditEntry[];
  /** "<step>|<host>|<timeline>" -> the backup made for that request. */
  backups: Record<string, string>;
  /** Per editor: clip ids a revert or a replacement changed, old -> new, so older changes follow them. */
  restoredIds: Record<NleHost, Record<string, string>>;
  log: (entry: Omit<EditEntry, "id" | "at">) => EditEntry;
  setBackup: (key: string, name: string) => void;
  addRestoredIds: (host: NleHost, ids: Record<string, string>) => void;
  markReverted: (id: string, info: NonNullable<EditEntry["reverted"]>) => void;
}

export const useEditLogStore = create<EditLogState>()((set, get) => ({
  entries: [],
  backups: {},
  restoredIds: { premiere: {}, resolve: {} },
  log: (entry) => {
    const logged: EditEntry = { ...entry, id: `e${get().entries.length + 1}`, at: Date.now() };
    set((s) => ({ entries: [...s.entries, logged] }));
    return logged;
  },
  setBackup: (key, name) => set((s) => ({ backups: { ...s.backups, [key]: name } })),
  addRestoredIds: (host, ids) =>
    set((s) => ({ restoredIds: { ...s.restoredIds, [host]: { ...s.restoredIds[host], ...ids } } })),
  markReverted: (id, info) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, reverted: info } : e)) })),
}));

/** Every unreverted entry of the newest request that has one. */
export function lastEditStep(entries: EditEntry[] = useEditLogStore.getState().entries): string[] {
  const live = entries.filter((e) => !e.reverted);
  const step = live[live.length - 1]?.step;
  return step ? live.filter((e) => e.step === step).map((e) => e.id) : [];
}
