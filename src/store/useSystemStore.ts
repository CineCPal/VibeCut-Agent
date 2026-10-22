import { create } from "zustand";
import type { DependencyInfo, HwAccel, KeyStatus, StoragePaths } from "../types/system";
import type { SidecarInfo } from "../types/sidecar";
import type { AntigravityStatus, ClaudeCodeStatus } from "../types/agent";
import {
  getAntigravityStatus,
  getClaudeCodeStatus,
  getDependencyStatus,
  getHardwareAcceleration,
  getKeyStatus,
  getSidecarInfo,
  getStoragePaths,
} from "../lib/ipc";

export interface SystemState {
  keys: KeyStatus | null;
  dependencies: DependencyInfo[];
  hwAccel: HwAccel | null;
  storage: StoragePaths | null;
  sidecar: SidecarInfo | null;
  /** Claude (subscription): whether Claude Code is there and signed in. Null until checked. */
  claudeCode: ClaudeCodeStatus | null;
  /** Gemini (subscription), Phase 17: whether agy is there, signed in and has VibeCut's tools. Null until checked. */
  antigravity: AntigravityStatus | null;
  loading: boolean;
  error: string | null;
  checkedAt: number | null;
  refresh: () => Promise<void>;
  /** After a key was saved or removed in Settings. */
  setKeys: (keys: KeyStatus) => void;
  /** Runs `claude auth status` again (a second or so; not part of `refresh`'s wait). */
  refreshClaudeCode: () => Promise<void>;
  setClaudeCode: (status: ClaudeCodeStatus) => void;
  /** Runs `agy models` again (two seconds or so; not part of `refresh`'s wait). */
  refreshAntigravity: () => Promise<void>;
  setAntigravity: (status: AntigravityStatus) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useSystemStore = create<SystemState>()((set, get) => ({
  keys: null,
  dependencies: [],
  hwAccel: null,
  storage: null,
  sidecar: null,
  claudeCode: null,
  antigravity: null,
  loading: false,
  error: null,
  checkedAt: null,
  setKeys: (keys) => set({ keys }),
  setClaudeCode: (claudeCode) => set({ claudeCode }),
  refreshClaudeCode: async () => {
    try {
      set({ claudeCode: await getClaudeCodeStatus() });
    } catch (error) {
      set({ claudeCode: { program: null, programSaved: null, configDir: null, signedIn: null, email: null, subscription: null, detail: message(error) } });
    }
  },
  setAntigravity: (antigravity) => set({ antigravity }),
  refreshAntigravity: async () => {
    try {
      set({ antigravity: await getAntigravityStatus() });
    } catch (error) {
      set({
        antigravity: { program: null, programSaved: null, signedIn: null, models: [], toolsAdded: false, toolsCurrent: false, detail: message(error) },
      });
    }
  },
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    void get().refreshClaudeCode();
    void get().refreshAntigravity();
    try {
      const [keys, dependencies, hwAccel, storage, sidecar] = await Promise.all([
        getKeyStatus(),
        getDependencyStatus(),
        getHardwareAcceleration(),
        getStoragePaths(),
        getSidecarInfo(),
      ]);
      set({ keys, dependencies, hwAccel, storage, sidecar, loading: false, checkedAt: Date.now() });
    } catch (error) {
      set({ loading: false, error: message(error) });
    }
  },
}));
