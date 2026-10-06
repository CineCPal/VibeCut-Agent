import { create } from "zustand";
import type { NleHost } from "../types/nle";
import type { HostPool } from "../types/pool";
import type { HostDraft } from "../vibecut/lib/connect/hostDraft";
import type { SpeakerInfo } from "../vibecut/types/media";

/**
 * What the agent knows about each editor's project beyond the open timeline (PLAN.md, "Phase 6a"): the
 * timelines it made (it may switch to and rename those freely), the last read of the Media Pool /
 * Project panel, the short pool ids ("p3") it uses for those clips, and (Phase 6b) the open draft and the
 * speakers' names and roles it was told. The part of VibeCut's useConnectStore these tools need. In
 * memory, and started over when the editor's project changes.
 */
export interface Connection {
  /** The project this was read from; another project starts everything over. */
  project: string | null;
  madeTimelines: string[];
  pool: HostPool | null;
  poolError: string | null;
  /** Editor clip id -> short id ("p3"), stable for the connection. */
  aliases: Record<string, string>;
  /** The draft of a timeline (`draft.base`): cuts made by what is said, sent as a new timeline. */
  draft: HostDraft | null;
  /** Speakers' names and roles by media file, then by speaker id ("Speaker 1"). */
  speakerInfo: Record<string, Record<string, SpeakerInfo>>;
  /** Sync offsets found by waveform (Phase 6c), "<camera path>|<recorder path>" -> seconds
   * (camera time = recorder time + offset), as VibeCut keeps them for a connection. */
  syncOffsets: Record<string, number>;
}

export const emptyConnection = (project: string | null = null): Connection => ({
  project,
  madeTimelines: [],
  pool: null,
  poolError: null,
  aliases: {},
  draft: null,
  speakerInfo: {},
  syncOffsets: {},
});

export interface ConnectionState {
  connections: Record<NleHost, Connection>;
  /** Starts over when `project` isn't the one the connection was made in. */
  forProject: (host: NleHost, project: string | null) => void;
  addMadeTimeline: (host: NleHost, name: string) => void;
  /** A timeline the agent made was renamed: its new name is still one it made. */
  renameMadeTimeline: (host: NleHost, from: string, to: string) => void;
  setPool: (host: NleHost, pool: HostPool) => void;
  setPoolError: (host: NleHost, message: string | null) => void;
  setDraft: (host: NleHost, draft: HostDraft | null) => void;
  setSpeakerInfo: (host: NleHost, file: string, bySpeaker: Record<string, SpeakerInfo>) => void;
  addSyncOffsets: (host: NleHost, offsets: Record<string, number>) => void;
}

const update = (s: ConnectionState, host: NleHost, change: (c: Connection) => Partial<Connection>) => ({
  connections: { ...s.connections, [host]: { ...s.connections[host], ...change(s.connections[host]) } },
});

export const useConnectionStore = create<ConnectionState>()((set) => ({
  connections: { premiere: emptyConnection(), resolve: emptyConnection() },
  forProject: (host, project) =>
    set((s) => {
      const now = s.connections[host];
      if (now.project === project) return s;
      // The first read of a session just records the project; a different one starts over.
      return now.project === null && !now.madeTimelines.length && !now.pool && !now.draft
        ? update(s, host, () => ({ project }))
        : { connections: { ...s.connections, [host]: emptyConnection(project) } };
    }),
  addMadeTimeline: (host, name) =>
    set((s) => update(s, host, (c) => ({ madeTimelines: c.madeTimelines.includes(name) ? c.madeTimelines : [...c.madeTimelines, name] }))),
  renameMadeTimeline: (host, from, to) =>
    set((s) => update(s, host, (c) => ({ madeTimelines: c.madeTimelines.map((n) => (n === from ? to : n)) }))),
  setPool: (host, pool) =>
    set((s) =>
      update(s, host, (c) => {
        const aliases = { ...c.aliases };
        let next = Object.keys(aliases).length;
        for (const clip of pool.clips) if (!aliases[clip.id]) aliases[clip.id] = `p${++next}`;
        return { pool, poolError: null, aliases };
      }),
    ),
  setPoolError: (host, poolError) => set((s) => update(s, host, () => ({ poolError }))),
  setDraft: (host, draft) => set((s) => update(s, host, () => ({ draft }))),
  setSpeakerInfo: (host, file, bySpeaker) =>
    set((s) => update(s, host, (c) => ({ speakerInfo: { ...c.speakerInfo, [file]: { ...c.speakerInfo[file], ...bySpeaker } } }))),
  addSyncOffsets: (host, offsets) => set((s) => update(s, host, (c) => ({ syncOffsets: { ...c.syncOffsets, ...offsets } }))),
}));
