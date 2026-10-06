//! The "VibeCut Agent B-roll" panel docked in Premiere Pro (PLAN.md, "Phase 5b"): the B-roll Library
//! inside the editor, as VibeCut's own B-roll CEP panel is. A shot dragged from a CEP panel goes into
//! Premiere's Project panel or timeline with its insert marker (CEP's `com.adobe.cep.dnd.file.0`), which
//! a drag from another app's window doesn't get (live, 2026-10-06). The app keeps the Library, the index
//! and the editor calls; the panel is a view and remote control. Adapted from VibeCut's host_chat.rs and
//! host_thumbs.rs, cut to the B-roll tab. They talk through files; there is no network port.
//!
//! `~/Library/Application Support/VibeCut Agent/host-bridge/broll/premiere/` holds:
//! - `inbox/<id>.json`: one action from the panel, renamed into place. Read here, checked, deleted and
//!   handed to the frontend as a `broll-panel-action` event.
//! - `broll.json`: what the panel shows, written by the frontend through `broll_panel_publish`.
//! - `thumbs/s<shot id>.txt`: each shot's keyframe, scaled down, as a `data:` URL (the panel reads only
//!   text files it was named).
//! - `agent-alive.json`: stamped here every second, so the panel knows the app is running.
//! - `panel-alive.json`: stamped by the panel.
//!
//! The panel makes the folder when it starts, so nothing is written for a panel that has never run.

use crate::{spyglass, spyglass_archive};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const ACTION_EVENT: &str = "broll-panel-action";
const POLL: Duration = Duration::from_millis(150);
const HEARTBEAT: Duration = Duration::from_secs(1);
/// A panel heartbeat older than this means the panel is closed.
const PANEL_STALE: Duration = Duration::from_secs(5);
const MAX_ACTION_BYTES: u64 = 64 * 1024;
const MAX_KEYS: usize = 200;
const MAX_QUERY_CHARS: usize = 500;
const MAX_PATH_CHARS: usize = 4096;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
/// Width of a thumbnail in pixels; the height follows the picture's shape.
const THUMB_WIDTH: u32 = 240;
/// The most thumbnails asked for at once, and kept.
const MAX_THUMBS_ASKED: usize = 200;
const MAX_THUMBS_KEPT: usize = 800;

static STARTED: AtomicBool = AtomicBool::new(false);

/// The panel's folder. `VIBECUT_AGENT_BROLL_PANEL_DIR` overrides it (tests and parallel dev builds).
pub fn panel_dir() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_BROLL_PANEL_DIR") {
        return Ok(PathBuf::from(custom));
    }
    let home = std::env::var_os("HOME").ok_or("HOME isn't set")?;
    Ok(Path::new(&home).join("Library/Application Support/VibeCut Agent/host-bridge/broll/premiere"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A list of shot keys (never paths): up to `MAX_KEYS`, at least `min`.
fn keys_field(action: &Map<String, Value>, min: usize) -> Result<Vec<Value>, String> {
    let Some(Value::Array(keys)) = action.get("keys") else {
        return Err("keys must be a list".into());
    };
    if keys.len() < min || keys.len() > MAX_KEYS {
        return Err(format!("keys must list {min} to {MAX_KEYS} entries"));
    }
    if !keys.iter().all(|k| k.as_str().is_some_and(valid_id)) {
        return Err("keys must be B-roll ids".into());
    }
    Ok(keys.clone())
}

/// A Spyglass folder's path from the panel's list. The app acts only on a folder it listed itself.
fn folder_field(action: &Map<String, Value>) -> Result<String, String> {
    let Some(Value::String(path)) = action.get("path") else {
        return Err("path must be a string".into());
    };
    if path.is_empty() || path.contains('\0') || path.chars().count() > MAX_PATH_CHARS {
        return Err("path must be a folder from the panel's list".into());
    }
    Ok(path.clone())
}

/// Checks one action and rebuilds it from the fields its type allows, so nothing else reaches the
/// frontend. `file_id` must be its id. VibeCut's `validate_action`, cut to the B-roll actions.
pub fn validate_action(value: &Value, file_id: &str) -> Result<Value, String> {
    let Value::Object(action) = value else {
        return Err("an action must be an object".into());
    };
    if action.get("id").and_then(Value::as_str) != Some(file_id) {
        return Err("the action's id must match its file name".into());
    }
    let kind = action.get("type").and_then(Value::as_str).ok_or("type must be a string")?;
    let mut out = Map::new();
    out.insert("id".into(), Value::String(file_id.into()));
    out.insert("type".into(), Value::String(kind.into()));
    match kind {
        "broll_expand" => {
            out.insert("path".into(), Value::String(folder_field(action)?));
        }
        "broll_scope" => {
            out.insert("path".into(), Value::String(folder_field(action)?));
            let checked = action.get("checked").and_then(Value::as_bool).ok_or("checked must be true or false")?;
            out.insert("checked".into(), Value::Bool(checked));
        }
        "broll_search" => {
            // Empty: browse the scope instead of searching it.
            let Some(Value::String(query)) = action.get("query") else {
                return Err("query must be a string".into());
            };
            let query = query.trim();
            if query.chars().count() > MAX_QUERY_CHARS {
                return Err(format!("query is longer than {MAX_QUERY_CHARS} characters"));
            }
            out.insert("query".into(), Value::String(query.into()));
        }
        "broll_pool" => {
            let op = action
                .get("op")
                .and_then(Value::as_str)
                .filter(|op| matches!(*op, "add" | "remove" | "clear" | "up" | "down"))
                .ok_or("op must be add, remove, clear, up or down")?;
            out.insert("op".into(), Value::String(op.into()));
            out.insert("keys".into(), Value::Array(keys_field(action, if op == "clear" { 0 } else { 1 })?));
        }
        "broll_import" => {
            out.insert("keys".into(), Value::Array(keys_field(action, 1)?));
        }
        "broll_place" | "broll_source" => {
            let key = action.get("key").and_then(Value::as_str).filter(|k| valid_id(k)).ok_or("key must be a B-roll id")?;
            out.insert("key".into(), Value::String(key.into()));
        }
        "broll_open" | "broll_more" | "broll_clear_scope" | "hello" => {}
        other => return Err(format!("unknown action type {other:?}")),
    }
    Ok(Value::Object(out))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEvent {
    /// The checked action, or None when it was refused.
    pub action: Option<Value>,
    /// Why it was refused.
    pub error: Option<String>,
    pub file_id: String,
}

fn read_action(path: &Path, file_id: &str) -> Result<Value, String> {
    if !valid_id(file_id) {
        return Err("the action's file name isn't an id".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("the action isn't a plain file".into());
    }
    if meta.len() > MAX_ACTION_BYTES {
        return Err("the action is too large".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("couldn't read the action: {e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("the action isn't JSON: {e}"))?;
    validate_action(&value, file_id)
}

/// Reads, checks and deletes every action waiting in the inbox, oldest first.
pub fn drain_inbox(dir: &Path) -> Vec<ActionEvent> {
    let Ok(entries) = std::fs::read_dir(dir.join("inbox")) else {
        return Vec::new();
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter(|p| p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.')))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), p))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|(_, path)| {
            let file_id = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let checked = read_action(&path, &file_id);
            let _ = std::fs::remove_file(&path);
            let file_id = if valid_id(&file_id) { file_id } else { String::new() };
            match checked {
                Ok(action) => ActionEvent { action: Some(action), error: None, file_id },
                Err(error) => ActionEvent { action: None, error: Some(error), file_id },
            }
        })
        .collect()
}

/// Writes `name` in `dir` through a temporary file and a rename, so a reader never sees half of it.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write {name}: {e}"))?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| format!("Couldn't write {name}: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Whether the panel stamped its heartbeat within `PANEL_STALE`.
pub fn panel_attached(dir: &Path) -> bool {
    std::fs::metadata(dir.join("panel-alive.json"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age <= PANEL_STALE)
}

fn serve(app: AppHandle, dir: PathBuf) {
    let mut last_beat: Option<std::time::Instant> = None;
    loop {
        if dir.is_dir() {
            if last_beat.is_none_or(|t| t.elapsed() >= HEARTBEAT) {
                let stamp = format!("{{\"at\":{},\"pid\":{}}}", now_ms(), std::process::id());
                let _ = write_atomic(&dir, "agent-alive.json", stamp.as_bytes());
                last_beat = Some(std::time::Instant::now());
            }
            for event in drain_inbox(&dir) {
                let _ = app.emit(ACTION_EVENT, event);
            }
        }
        std::thread::sleep(POLL);
    }
}

/// Starts watching the panel's inbox and stamping the app's heartbeat (once per app run).
pub fn start(app: &AppHandle) {
    let Ok(dir) = panel_dir() else { return };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("broll-panel".into()).spawn(move || serve(app, dir));
}

/// Writes `broll.json`. Returns false (writing nothing) when the panel has never run.
#[tauri::command]
pub fn broll_panel_publish(file: Value) -> Result<bool, String> {
    let dir = panel_dir()?;
    if !dir.is_dir() {
        return Ok(false);
    }
    let bytes = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("The B-roll panel's file is too large".into());
    }
    write_atomic(&dir, "broll.json", &bytes)?;
    Ok(true)
}

/// Whether the panel is open in Premiere now.
#[tauri::command]
pub fn broll_panel_status() -> Result<bool, String> {
    Ok(panel_attached(&panel_dir()?))
}

// ----------------------------------------------------------------------------- thumbnails

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn thumb_name(shot_id: i64) -> String {
    format!("s{shot_id}.txt")
}

/// A keyframe scaled to `THUMB_WIDTH` wide, as a JPEG `data:` URL.
pub fn thumb_data_url(keyframe: &Path) -> Option<String> {
    let picture = image::open(keyframe).ok()?;
    let small = picture.thumbnail(THUMB_WIDTH, THUMB_WIDTH * 4).to_rgb8();
    let mut jpeg = std::io::Cursor::new(Vec::new());
    small.write_to(&mut jpeg, image::ImageFormat::Jpeg).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&jpeg.into_inner())))
}

/// Deletes all but the newest `keep` thumbnails.
pub fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut thumbs: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('s')) && p.extension().is_some_and(|x| x == "txt"))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), p))
        .collect();
    if thumbs.len() <= keep {
        return;
    }
    thumbs.sort();
    for (_, path) in &thumbs[..thumbs.len() - keep] {
        let _ = std::fs::remove_file(path);
    }
}

/// Writes the thumbnails of these shots that aren't there yet; returns the shots that have one.
#[tauri::command]
pub async fn broll_panel_thumbs(app: AppHandle, shot_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    if shot_ids.len() > MAX_THUMBS_ASKED {
        return Err(format!("Ask for at most {MAX_THUMBS_ASKED} thumbnails at a time"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let panel = panel_dir()?;
        if !panel.is_dir() {
            return Ok(Vec::new());
        }
        let dir = panel.join("thumbs");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the thumbnail folder: {e}"))?;
        let missing: Vec<i64> = shot_ids.iter().copied().filter(|id| !dir.join(thumb_name(*id)).is_file()).collect();
        if !missing.is_empty() {
            let index = spyglass::index_for(&app).ok_or("Spyglass has no index on this computer.")?;
            let conn = spyglass_archive::open_readonly(&index)?;
            for (shot_id, keyframe) in spyglass_archive::keyframes(&conn, &missing)? {
                // A keyframe that can't be read just has no picture in the panel.
                if let Some(url) = thumb_data_url(Path::new(&keyframe)) {
                    let _ = write_atomic(&dir, &thumb_name(shot_id), url.as_bytes());
                }
            }
            prune(&dir, MAX_THUMBS_KEPT);
        }
        Ok(shot_ids.into_iter().filter(|id| dir.join(thumb_name(*id)).is_file()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-broll-panel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("inbox")).unwrap();
        dir
    }

    #[test]
    fn actions_are_rebuilt_from_the_fields_their_type_allows() {
        let search = validate_action(&json!({"id": "a1", "type": "broll_search", "query": "  sunset ", "path": "/etc"}), "a1").unwrap();
        assert_eq!(search, json!({"id": "a1", "type": "broll_search", "query": "sunset"}));
        let pool = validate_action(&json!({"id": "a2", "type": "broll_pool", "op": "clear", "keys": []}), "a2").unwrap();
        assert_eq!(pool, json!({"id": "a2", "type": "broll_pool", "op": "clear", "keys": []}));
        assert!(validate_action(&json!({"id": "a3", "type": "broll_place", "key": "../x"}), "a3").is_err());
        assert!(validate_action(&json!({"id": "a4", "type": "broll_import", "keys": []}), "a4").is_err());
        assert!(validate_action(&json!({"id": "a5", "type": "send", "text": "hi"}), "a5").is_err());
        assert!(validate_action(&json!({"id": "a6", "type": "broll_open"}), "other").is_err());
        assert!(validate_action(&json!({"id": "a7", "type": "broll_scope", "path": "/Volumes/A"}), "a7").is_err());
    }

    #[test]
    fn the_inbox_is_drained_oldest_first_and_bad_files_are_refused() {
        let dir = temp_dir("drain");
        std::fs::write(dir.join("inbox/a1.json"), r#"{"id":"a1","type":"broll_open"}"#).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("inbox/a2.json"), "not json").unwrap();
        std::fs::write(dir.join("inbox/.a3.json.tmp"), "{}").unwrap();
        let events = drain_inbox(&dir);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].action, Some(json!({"id": "a1", "type": "broll_open"})));
        assert!(events[1].error.as_deref().unwrap().contains("isn't JSON"));
        let left: Vec<_> = std::fs::read_dir(dir.join("inbox")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "the hidden half-written file stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn a_keyframe_becomes_a_small_jpeg_data_url_and_old_ones_are_pruned() {
        let dir = temp_dir("thumbs");
        let jpg = dir.join("k.jpg");
        image::RgbImage::from_pixel(480, 270, image::Rgb([10, 200, 30])).save(&jpg).unwrap();
        let url = thumb_data_url(&jpg).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,/9j/"));
        for i in 0..4 {
            std::fs::write(dir.join(thumb_name(i)), "x").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        prune(&dir, 2);
        assert!(!dir.join(thumb_name(0)).exists() && dir.join(thumb_name(3)).exists());
        assert!(dir.join("k.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
