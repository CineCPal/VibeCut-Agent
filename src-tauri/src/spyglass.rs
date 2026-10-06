//! The B-roll Library's view of Spyglass's index (`spyglass_index.sqlite`, kept by Spyglass in the Rough Cut
//! Studio Suite - Blair Themed). Ported from VibeCut. Folders, scopes, browse pages and keyframes are read
//! here (spyglass_archive.rs); the text search, which needs SigLIP 2 / CLIP, is the Python sidecar's
//! `broll-spyglass` (`broll/spyglass_index.py`). Everything is read only.
//!
//! `spyglass_start_drag` starts a native file drag of a shot's clip, so it drops into Premiere's Project
//! panel or timeline, or Resolve's Media Pool or timeline, as a file dragged from Finder would. The webview
//! names only the shot; the file is looked up in the index here.

use crate::spyglass_archive::{self, Archive, BrowseShot, FolderNode, ScopeSummary};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::{AppHandle, Manager, WebviewWindow};

const APP_ID: &str = "edu.blair.spyglass";
const INDEX_FILE: &str = "spyglass_index.sqlite";
const ENV_INDEX: &str = "VIBECUT_SPYGLASS_INDEX";

/// Where the index in use came from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IndexSource {
    /// `$VIBECUT_SPYGLASS_INDEX` (a dev shell, e.g. `~/.zshenv`).
    Environment,
    /// Chosen in Settings → B-roll Library and saved in the app's config folder.
    Chosen,
    /// Spyglass's own app data folder.
    Default,
}

/// The index file, first that names an existing file: `$VIBECUT_SPYGLASS_INDEX`, then the one chosen in
/// Settings, then Spyglass's own folder inside `data_dir` (`~/Library/Application Support` on macOS).
/// A suite such as Rough Cut Studio Suite - Blair Themed can keep its index elsewhere, hence the choice.
pub fn find_index(env_override: Option<&str>, chosen: Option<&Path>, data_dir: &Path) -> Option<(PathBuf, IndexSource)> {
    let from_env = env_override.filter(|p| !p.is_empty()).map(|p| (PathBuf::from(p), IndexSource::Environment));
    let chosen = chosen.map(|p| (p.to_path_buf(), IndexSource::Chosen));
    from_env
        .into_iter()
        .chain(chosen)
        .chain(std::iter::once((data_dir.join(APP_ID).join(INDEX_FILE), IndexSource::Default)))
        .find(|(path, _)| path.is_absolute() && path.is_file())
}

const CHOICE_FILE: &str = "spyglass.json";

fn choice_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CHOICE_FILE))
}

/// The index chosen in Settings, if any.
fn chosen_index(app: &AppHandle) -> Option<PathBuf> {
    let text = std::fs::read_to_string(choice_file(app)?).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("index")?.as_str().map(PathBuf::from)
}

pub fn locate(app: &AppHandle) -> Option<(PathBuf, IndexSource)> {
    let data = app.path().data_dir().ok()?;
    find_index(std::env::var(ENV_INDEX).ok().as_deref(), chosen_index(app).as_deref(), &data)
}

pub fn index_for(app: &AppHandle) -> Option<PathBuf> {
    locate(app).map(|(path, _)| path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub path: String,
    pub source: IndexSource,
    /// The chosen file when the environment overrides it, so Settings can say so.
    pub chosen: Option<String>,
}

#[tauri::command]
pub async fn find_spyglass_index(app: AppHandle) -> Option<IndexInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, source) = locate(&app)?;
        let chosen = chosen_index(&app).map(|p| p.to_string_lossy().into_owned());
        Some(IndexInfo { path: path.to_string_lossy().into_owned(), source, chosen })
    })
    .await
    .ok()
    .flatten()
}

/// Saves the index to use (checked to be a readable Spyglass index first), or forgets the choice (`None`).
#[tauri::command]
pub async fn spyglass_choose_index(app: AppHandle, path: Option<String>) -> Result<Option<IndexInfo>, String> {
    let saver = app.clone();
    blocking(move || {
        let file = choice_file(&saver).ok_or_else(|| "The app's config folder is unavailable".to_string())?;
        match path {
            Some(path) => {
                let index = PathBuf::from(&path);
                if !index.is_absolute() {
                    return Err("Choose the index by its full path".into());
                }
                spyglass_archive::open_readonly(&index)?;
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&file, serde_json::json!({ "index": path }).to_string()).map_err(|e| e.to_string())?;
            }
            None => {
                let _ = std::fs::remove_file(&file);
            }
        }
        Ok(())
    })
    .await?;
    Ok(find_spyglass_index(app).await)
}

/// The last archive read, kept while the index file (and its write-ahead log) is unchanged, so expanding
/// the folder tree does not re-read every clip each time.
#[derive(Default)]
pub struct ArchiveCache(Mutex<Option<CachedArchive>>);

/// The index file, its (and its write-ahead log's) modification times when read, and what was read.
type CachedArchive = (PathBuf, Vec<Option<SystemTime>>, Arc<Archive>);

fn stamp(index: &Path) -> Vec<Option<SystemTime>> {
    let wal = PathBuf::from(format!("{}-wal", index.to_string_lossy()));
    [index.to_path_buf(), wal].iter().map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).collect()
}

const NO_INDEX: &str = "Spyglass has no index on this computer.";

/// Opens the index read-only and returns it with its (possibly cached) archive.
fn open_archive(app: &AppHandle, cache: &ArchiveCache) -> Result<(rusqlite::Connection, Arc<Archive>), String> {
    let index = index_for(app).ok_or_else(|| NO_INDEX.to_string())?;
    let conn = spyglass_archive::open_readonly(&index)?;
    let now = stamp(&index);
    let mut slot = cache.0.lock().map_err(|_| "The Spyglass cache is unavailable".to_string())?;
    if let Some((path, when, archive)) = slot.as_ref() {
        if *path == index && *when == now {
            return Ok((conn, archive.clone()));
        }
    }
    let archive = Arc::new(Archive::load(&conn)?);
    *slot = Some((index, now, archive.clone()));
    Ok((conn, archive))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// The watched roots (`parent` absent) or the folders directly inside `parent`. Read only.
#[tauri::command]
pub async fn spyglass_folder_children(app: AppHandle, parent: Option<String>) -> Result<Vec<FolderNode>, String> {
    blocking(move || {
        let cache = app.state::<ArchiveCache>();
        let (_, archive) = open_archive(&app, &cache)?;
        Ok(archive.children(parent.as_deref()))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedScope {
    pub clip_ids: Vec<i64>,
    pub summary: ScopeSummary,
}

/// The Spyglass clip ids under any of `scopes` (every watched root when empty), for a scoped search.
#[tauri::command]
pub async fn spyglass_resolve_scope(app: AppHandle, scopes: Vec<String>) -> Result<ResolvedScope, String> {
    blocking(move || {
        let cache = app.state::<ArchiveCache>();
        let (_, archive) = open_archive(&app, &cache)?;
        let members = archive.resolve(&scopes)?;
        Ok(ResolvedScope { clip_ids: archive.clip_ids(&members), summary: archive.summary(&members) })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub summary: ScopeSummary,
    pub shots: Vec<BrowseShot>,
}

/// Lets the webview show these images, and only these: each is a keyframe path read from the index and
/// checked to be an existing image file (`spyglass_archive::is_image_file`).
fn allow_images(app: &AppHandle, paths: impl Iterator<Item = String>) {
    let scope = app.asset_protocol_scope();
    for path in paths {
        let _ = scope.allow_file(path);
    }
}

/// One page of the shots under `scopes`, with what Spyglass saw in each. Read only.
#[tauri::command]
pub async fn spyglass_browse(app: AppHandle, scopes: Vec<String>, offset: usize, limit: usize) -> Result<BrowsePage, String> {
    blocking(move || {
        let cache = app.state::<ArchiveCache>();
        let (conn, archive) = open_archive(&app, &cache)?;
        let members = archive.resolve(&scopes)?;
        let shots = archive.browse(&conn, &members, offset, limit)?;
        allow_images(&app, shots.iter().filter_map(|s| s.keyframe.clone()));
        Ok(BrowsePage { summary: archive.summary(&members), shots })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub shot_id: i64,
    pub path: String,
}

/// The keyframe images of these shots (for search results), made loadable by the webview.
#[tauri::command]
pub async fn spyglass_keyframes(app: AppHandle, shot_ids: Vec<i64>) -> Result<Vec<Keyframe>, String> {
    if shot_ids.len() > 1000 {
        return Err("Ask for at most 1000 keyframes at a time".into());
    }
    blocking(move || {
        let index = index_for(&app).ok_or_else(|| NO_INDEX.to_string())?;
        let conn = spyglass_archive::open_readonly(&index)?;
        let found = spyglass_archive::keyframes(&conn, &shot_ids)?;
        allow_images(&app, found.iter().map(|(_, p)| p.clone()));
        Ok(found.into_iter().map(|(shot_id, path)| Keyframe { shot_id, path }).collect())
    })
    .await
}

/// The drag icon when a shot has no keyframe on disk.
const FALLBACK_ICON: &[u8] = include_bytes!("../icons/32x32.png");
/// The drag icon's width in points: small enough not to hide where it's dropped.
const ICON_WIDTH: u32 = 160;

/// A shot ready to drag: its clip file and a small PNG icon made from its keyframe.
#[derive(Clone)]
struct Prepared {
    path: PathBuf,
    icon: Vec<u8>,
}

/// Shots prepared for dragging, by shot id. Filled for each page or search the Library shows
/// (`spyglass_prepare_drag`), so the drag itself starts without touching the index or the disk.
#[derive(Default)]
pub struct DragCache(Mutex<std::collections::HashMap<i64, Prepared>>);

/// A keyframe shrunk to `ICON_WIDTH` wide, as PNG; None if it can't be read.
pub fn drag_icon(keyframe: &Path) -> Option<Vec<u8>> {
    let picture = image::open(keyframe).ok()?;
    let small = picture.thumbnail(ICON_WIDTH, ICON_WIDTH);
    let mut png = std::io::Cursor::new(Vec::new());
    small.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

fn prepare(app: &AppHandle, shot_ids: &[i64]) -> Result<(), String> {
    let cache = app.state::<DragCache>();
    let missing: Vec<i64> = {
        let known = cache.0.lock().map_err(|_| "The drag cache is unavailable".to_string())?;
        shot_ids.iter().copied().filter(|id| !known.contains_key(id)).collect()
    };
    if missing.is_empty() {
        return Ok(());
    }
    let index = index_for(app).ok_or_else(|| NO_INDEX.to_string())?;
    let conn = spyglass_archive::open_readonly(&index)?;
    let mut ready = Vec::new();
    for id in missing {
        if let Some((path, keyframe)) = spyglass_archive::shot_file(&conn, id)? {
            let icon = keyframe.and_then(|k| drag_icon(Path::new(&k))).unwrap_or_else(|| FALLBACK_ICON.to_vec());
            ready.push((id, Prepared { path: PathBuf::from(path), icon }));
        }
    }
    let mut known = cache.0.lock().map_err(|_| "The drag cache is unavailable".to_string())?;
    known.extend(ready);
    Ok(())
}

/// Gets these shots ready to drag (the Library calls it for each page and search it shows).
#[tauri::command]
pub async fn spyglass_prepare_drag(app: AppHandle, shot_ids: Vec<i64>) -> Result<(), String> {
    if shot_ids.len() > 1000 {
        return Err("Prepare at most 1000 shots at a time".into());
    }
    blocking(move || prepare(&app, &shot_ids)).await
}

/// Starts a native drag of a shot's whole clip file out of the window (as from Finder). It must start
/// while the mouse button is down (the card's `dragstart`), so it's a synchronous command: Tauri runs
/// those on the main thread, where AppKit needs the drag, with no thread hops in between. A shot not
/// prepared yet is looked up now. An offline file is refused with a reason the Library can show.
#[tauri::command]
pub fn spyglass_start_drag(app: AppHandle, window: WebviewWindow, shot_id: i64) -> Result<(), String> {
    let cached = app.state::<DragCache>().0.lock().ok().and_then(|c| c.get(&shot_id).cloned());
    let shot = match cached {
        Some(shot) => shot,
        None => {
            prepare(&app, &[shot_id])?;
            app.state::<DragCache>()
                .0
                .lock()
                .ok()
                .and_then(|c| c.get(&shot_id).cloned())
                .ok_or_else(|| "That shot is no longer in Spyglass's index.".to_string())?
        }
    };
    if !shot.path.is_file() {
        let name = shot.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(format!("{name} isn't reachable (is its drive attached?)"));
    }
    #[cfg(target_os = "macos")]
    return crate::native_drag::start_file_drag(&window, &shot.path, &shot.icon);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Dragging into an editor works on macOS only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibecut-spyglass-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_spyglass_in_its_own_app_data_folder() {
        let data = temp("own");
        assert_eq!(find_index(None, None, &data), None);
        fs::create_dir_all(data.join(APP_ID)).unwrap();
        fs::write(data.join(APP_ID).join(INDEX_FILE), b"").unwrap();
        assert_eq!(find_index(None, None, &data), Some((data.join(APP_ID).join(INDEX_FILE), IndexSource::Default)));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn an_override_wins_when_it_names_a_real_file_and_is_ignored_otherwise() {
        let data = temp("override");
        let custom = data.join("custom.sqlite");
        fs::write(&custom, b"").unwrap();
        fs::create_dir_all(data.join(APP_ID)).unwrap();
        fs::write(data.join(APP_ID).join(INDEX_FILE), b"").unwrap();
        let default = Some((data.join(APP_ID).join(INDEX_FILE), IndexSource::Default));
        assert_eq!(find_index(Some(custom.to_str().unwrap()), None, &data), Some((custom.clone(), IndexSource::Environment)));
        assert_eq!(find_index(Some("/definitely/not/here.sqlite"), None, &data), default);
        assert_eq!(find_index(Some(""), None, &data), default);
        assert_eq!(find_index(Some("relative.sqlite"), None, &data), default);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_keyframe_becomes_a_small_png_icon() {
        let dir = temp("icon");
        let jpg = dir.join("k.jpg");
        image::RgbImage::from_pixel(480, 270, image::Rgb([200, 40, 40])).save(&jpg).unwrap();
        let icon = drag_icon(&jpg).unwrap();
        let back = image::load_from_memory(&icon).unwrap();
        assert_eq!((back.width(), back.height()), (160, 90));
        assert!(drag_icon(&dir.join("missing.jpg")).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_is_not_an_index() {
        let data = temp("folder");
        fs::create_dir_all(data.join(APP_ID).join(INDEX_FILE)).unwrap();
        assert_eq!(find_index(None, None, &data), None);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_chosen_index_comes_after_the_environment_and_before_spyglass_own() {
        let data = temp("chosen");
        let chosen = data.join("suite.sqlite");
        let env = data.join("env.sqlite");
        fs::write(&chosen, b"").unwrap();
        fs::write(&env, b"").unwrap();
        fs::create_dir_all(data.join(APP_ID)).unwrap();
        fs::write(data.join(APP_ID).join(INDEX_FILE), b"").unwrap();
        assert_eq!(find_index(None, Some(&chosen), &data), Some((chosen.clone(), IndexSource::Chosen)));
        assert_eq!(find_index(Some(env.to_str().unwrap()), Some(&chosen), &data), Some((env.clone(), IndexSource::Environment)));
        // A chosen file that has gone falls back to Spyglass's own.
        assert_eq!(find_index(None, Some(&data.join("gone.sqlite")), &data), Some((data.join(APP_ID).join(INDEX_FILE), IndexSource::Default)));
        let _ = fs::remove_dir_all(&data);
    }
}
