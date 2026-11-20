//! Project Kanban boards (`vibecut.kanban.v1`, docs/specs/kanban-spec.md, PLAN.md "Phase 23"): one
//! task board per editor project, shared by the editing agent, the supervising editor, the background
//! bots and the user. Stored as one JSON file per project in the app's data folder (`kanban/`), named
//! like project notes (`project_notes.rs`) so two projects whose names slug alike keep separate boards.
//!
//! `global` is the board for when no editor project is open: the user can plan before opening one.
//! Files are written atomically, private to the user, and at most `MAX_KANBAN_BYTES`.

use crate::broll_panel::write_atomic;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The most a board may hold: hundreds of cards with checklists.
pub const MAX_KANBAN_BYTES: usize = 512 * 1024;
pub const SCHEMA_VERSION: &str = "vibecut.kanban.v1";
const HOSTS: &[&str] = &["premiere", "resolve", "global"];
const GLOBAL_FILE: &str = "global-workspace.json";

static LOCK: Mutex<()> = Mutex::new(());

pub fn kanban_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("kanban")).map_err(|_| "The app's data folder is unavailable".to_string())
}

/// FNV-1a, 64-bit: stable across runs and builds, unlike std's hasher.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

/// `resolve-my-doc-1a2b3c4d5e6f7a8b.json` for Resolve's "My Doc"; `global-workspace.json` for the
/// board kept when no editor project is open (its project name is ignored).
pub fn file_name(host: &str, project: &str) -> Result<String, String> {
    if !HOSTS.contains(&host) {
        return Err(format!("{host} isn't an editor VibeCut Agent knows"));
    }
    if host == "global" {
        return Ok(GLOBAL_FILE.into());
    }
    let project = project.trim();
    if project.is_empty() || project.len() > 512 {
        return Err("The project needs a name".into());
    }
    let mut slug = String::new();
    for c in project.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    Ok(format!("{host}-{}{:016x}.json", if slug.is_empty() { String::new() } else { format!("{slug}-") }, fnv1a(&format!("{host}\n{project}"))))
}

/// The project's board, or `None` when it has none yet.
pub fn load_in(dir: &Path, host: &str, project: &str) -> Result<Option<Value>, String> {
    let path = dir.join(file_name(host, project)?);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Value>(&text).map(Some).map_err(|e| format!("Couldn't read the project's Kanban board: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't read the project's Kanban board: {e}")),
    }
}

/// Saves the board; a board with no cards that never had any (`nextCardSeq <= 1`) removes the file.
pub fn save_in(dir: &Path, host: &str, project: &str, board: &Value) -> Result<(), String> {
    let name = file_name(host, project)?;
    let Value::Object(map) = board else {
        return Err("A Kanban board must be a JSON object".into());
    };
    if map.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA_VERSION) {
        return Err(format!("A Kanban board's schemaVersion must be \"{SCHEMA_VERSION}\""));
    }
    let Some(Value::Array(cards)) = map.get("cards") else {
        return Err("A Kanban board needs a cards list".into());
    };
    let bytes = serde_json::to_vec(board).map_err(|e| format!("Couldn't write the Kanban board: {e}"))?;
    if bytes.len() > MAX_KANBAN_BYTES {
        return Err(format!("A Kanban board can hold at most {} KB; clear finished cards first", MAX_KANBAN_BYTES / 1024));
    }
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let next_seq = map.get("nextCardSeq").and_then(Value::as_u64).unwrap_or(1);
    if cards.is_empty() && next_seq <= 1 {
        return match std::fs::remove_file(dir.join(&name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Couldn't clear the project's Kanban board: {e}")),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    write_atomic(dir, &name, &bytes)
}

#[tauri::command]
pub async fn kanban_board_get(app: AppHandle, host: String, project: String) -> Result<Option<Value>, String> {
    load_in(&kanban_dir(&app)?, &host, &project)
}

#[tauri::command]
pub async fn kanban_board_set(app: AppHandle, host: String, project: String, board: Value) -> Result<(), String> {
    save_in(&kanban_dir(&app)?, &host, &project, &board)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-kanban-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn board(cards: Value, next: u64) -> Value {
        json!({ "schemaVersion": SCHEMA_VERSION, "host": "resolve", "project": "Doc", "nextCardSeq": next, "autoAdvanceWave": false, "updatedAt": 1, "cards": cards })
    }

    #[test]
    fn names_are_readable_stable_and_kept_apart() {
        let name = file_name("resolve", "My Doc / Cut 2").unwrap();
        assert!(name.starts_with("resolve-my-doc-cut-2-") && name.ends_with(".json"), "{name}");
        assert_eq!(name, file_name("resolve", "My Doc / Cut 2").unwrap());
        assert_ne!(file_name("resolve", "My Doc").unwrap(), file_name("resolve", "my doc").unwrap());
        assert_ne!(file_name("resolve", "Doc").unwrap(), file_name("premiere", "Doc").unwrap());
        assert!(file_name("avid", "Doc").is_err() && file_name("resolve", "  ").is_err());
        assert!(!file_name("resolve", "../../etc").unwrap().contains('/'));
    }

    #[test]
    fn the_global_board_has_one_file_whatever_the_project() {
        assert_eq!(file_name("global", "Workspace").unwrap(), "global-workspace.json");
        assert_eq!(file_name("global", "").unwrap(), "global-workspace.json");
        let dir = temp_dir("global");
        save_in(&dir, "global", "Workspace", &board(json!([{ "id": "kb_1" }]), 2)).unwrap();
        assert!(dir.join("global-workspace.json").exists());
        assert_eq!(load_in(&dir, "global", "anything").unwrap().unwrap()["cards"][0]["id"], "kb_1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn boards_round_trip_per_project() {
        let dir = temp_dir("round-trip");
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap(), None);
        let saved = board(json!([{ "id": "kb_1", "title": "Tighten pauses" }]), 2);
        save_in(&dir, "resolve", "Doc", &saved).unwrap();
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap(), Some(saved));
        assert_eq!(load_in(&dir, "premiere", "Doc").unwrap(), None);
        assert_eq!(load_in(&dir, "resolve", "doc").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_board_removes_the_file_only_if_it_never_had_cards() {
        let dir = temp_dir("empty");
        save_in(&dir, "resolve", "Doc", &board(json!([{ "id": "kb_1" }]), 2)).unwrap();
        // Cards deleted, but the counter must survive so kb_1 is never reused.
        save_in(&dir, "resolve", "Doc", &board(json!([]), 2)).unwrap();
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap().unwrap()["nextCardSeq"], 2);
        save_in(&dir, "resolve", "Doc", &board(json!([]), 1)).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_boards_are_refused() {
        let dir = temp_dir("malformed");
        assert!(save_in(&dir, "resolve", "Doc", &json!([])).is_err());
        assert!(save_in(&dir, "resolve", "Doc", &json!({ "schemaVersion": "v0", "cards": [] })).unwrap_err().contains("schemaVersion"));
        assert!(save_in(&dir, "resolve", "Doc", &json!({ "schemaVersion": SCHEMA_VERSION })).unwrap_err().contains("cards"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file_name("resolve", "Doc").unwrap()), "{not json").unwrap();
        assert!(load_in(&dir, "resolve", "Doc").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn boards_over_the_cap_are_refused_and_nothing_half_written_is_left() {
        let dir = temp_dir("cap");
        let kept = board(json!([{ "id": "kb_1" }]), 2);
        save_in(&dir, "resolve", "Doc", &kept).unwrap();
        let huge = board(json!([{ "id": "kb_2", "description": "x".repeat(MAX_KANBAN_BYTES) }]), 3);
        let err = save_in(&dir, "resolve", "Doc", &huge).unwrap_err();
        assert!(err.contains("512 KB"), "{err}");
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap(), Some(kept));
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
