/** Mirrors `View` in `src-tauri/src/state.rs`. */
export type View = "chat" | "broll" | "settings" | "about";

/** Where a key was found (`KeySource` in src-tauri/src/secrets.rs): the environment wins over the Keychain. */
export type KeySource = "environment" | "keychain";

/** Mirrors `KeyStatus` in src-tauri/src/secrets.rs: whether each key is set, and where. Never a key. */
export interface KeyStatus {
  gemini: boolean;
  anthropic: boolean;
  geminiSource: KeySource | null;
  anthropicSource: KeySource | null;
  /** The Hugging Face token, for transcripts with speaker labels (Phase 6b). */
  huggingface: boolean;
  huggingfaceSource: KeySource | null;
}

/** Every key Settings keeps (`Provider` in src-tauri/src/secrets.rs). */
export type KeyProvider = "gemini" | "anthropic" | "huggingface";

/** Mirrors the serde shapes in `src-tauri/src/commands.rs`. */

export interface DependencyInfo {
  name: string;
  path: string | null;
  version: string | null;
}

export interface HwAccel {
  videotoolbox: boolean;
  nvenc: boolean;
}

export interface StoragePaths {
  config: string | null;
  data: string | null;
  logs: string | null;
}
