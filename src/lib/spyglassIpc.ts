/**
 * The B-roll Library's view of Spyglass's index (src-tauri/src/spyglass.rs, ported from VibeCut). The
 * index belongs to Spyglass (Rough Cut Studio Suite - Blair Themed) and is only ever read.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { SpyglassBrowsePage, SpyglassFolder, SpyglassIndexInfo, SpyglassResolvedScope } from "../types/spyglass";

/** The index in use and where its location came from, or null if this computer has none. */
export function findSpyglassIndex(): Promise<SpyglassIndexInfo | null> {
  return invoke<SpyglassIndexInfo | null>("find_spyglass_index");
}

/** Saves the index to use (checked to be a Spyglass index first), or forgets the choice with null. */
export function chooseSpyglassIndex(path: string | null): Promise<SpyglassIndexInfo | null> {
  return invoke<SpyglassIndexInfo | null>("spyglass_choose_index", { path });
}

/** The watched roots (no parent) or the folders directly inside `parent`. */
export function spyglassFolderChildren(parent?: string): Promise<SpyglassFolder[]> {
  return invoke<SpyglassFolder[]>("spyglass_folder_children", { parent: parent ?? null });
}

/** The Spyglass clips under any of `scopes` (the whole archive when empty), for a scoped search. */
export function resolveSpyglassScope(scopes: string[]): Promise<SpyglassResolvedScope> {
  return invoke<SpyglassResolvedScope>("spyglass_resolve_scope", { scopes });
}

/** One page of the shots under `scopes`, ordered by clip and time. `limit` is at most 200. */
export function browseSpyglass(scopes: string[], offset: number, limit: number): Promise<SpyglassBrowsePage> {
  return invoke<SpyglassBrowsePage>("spyglass_browse", { scopes, offset, limit });
}

/** Keyframe images of these shots that exist, made loadable by the webview. */
export function spyglassKeyframes(shotIds: number[]): Promise<{ shotId: number; path: string }[]> {
  return invoke<{ shotId: number; path: string }[]>("spyglass_keyframes", { shotIds });
}

/** Gets shots ready to drag (their file and a small icon), so a drag starts the moment it's asked for. */
export function prepareShotDrags(shotIds: number[]): Promise<void> {
  return invoke<void>("spyglass_prepare_drag", { shotIds });
}

/** Starts a native drag of the shot's whole clip file (as from Finder), while the mouse is down. */
export function startShotDrag(shotId: number): Promise<void> {
  return invoke<void>("spyglass_start_drag", { shotId });
}

/** A keyframe path (already allowed by Rust) as an image URL. */
export const keyframeUrl = (path: string): string => convertFileSrc(path);
