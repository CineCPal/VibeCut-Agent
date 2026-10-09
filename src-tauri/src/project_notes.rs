//! Project notes (PLAN.md, "Phase 13c"): what the agent should remember about one editor project across
//! chats and providers (the brief, people, style, deliverables, decisions), as one Markdown file per
//! project in the app's data folder (`projects/`). The app puts it at the top of every snapshot; the
//! agent adds to it with `remember_note`, and the user edits it in the Notes window.
//!
//! A project is its editor and the name the editor gives it (Premiere's project name, Resolve's). The
//! file name is a readable slug of both plus a hash, so two names that slug alike don't share a file.
//! Files are written atomically, private to the user, and at most `MAX_NOTES_BYTES`.

use crate::broll_panel::write_atomic;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The most a project's notes may hold: plenty for notes, small enough to go with every message.
pub const MAX_NOTES_BYTES: usize = 16 * 1024;
const HOSTS: &[&str] = &["premiere", "resolve"];

static LOCK: Mutex<()> = Mutex::new(());

pub fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("projects")).map_err(|_| "The app's data folder is unavailable".to_string())
}

/// FNV-1a, 64-bit: stable across runs and builds, unlike std's hasher.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

/// `resolve-my-doc-1a2b3c4d5e6f7a8b.md` for Resolve's "My Doc".
pub fn file_name(host: &str, project: &str) -> Result<String, String> {
    if !HOSTS.contains(&host) {
        return Err(format!("{host} isn't an editor VibeCut Agent knows"));
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
    Ok(format!("{host}-{}{:016x}.md", if slug.is_empty() { String::new() } else { format!("{slug}-") }, fnv1a(&format!("{host}\n{project}"))))
}

pub fn load_in(dir: &Path, host: &str, project: &str) -> Result<String, String> {
    let path = dir.join(file_name(host, project)?);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Couldn't read the project's notes: {e}")),
    }
}

/// Saves the notes; empty notes remove the file.
pub fn save_in(dir: &Path, host: &str, project: &str, text: &str) -> Result<(), String> {
    let name = file_name(host, project)?;
    if text.len() > MAX_NOTES_BYTES {
        return Err(format!("Project notes can hold at most {} KB; shorten them first", MAX_NOTES_BYTES / 1024));
    }
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if text.trim().is_empty() {
        return match std::fs::remove_file(dir.join(&name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Couldn't clear the project's notes: {e}")),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    write_atomic(dir, &name, text.as_bytes())
}

#[tauri::command]
pub async fn project_notes_get(app: AppHandle, host: String, project: String) -> Result<String, String> {
    load_in(&notes_dir(&app)?, &host, &project)
}

#[tauri::command]
pub async fn project_notes_set(app: AppHandle, host: String, project: String, text: String) -> Result<(), String> {
    save_in(&notes_dir(&app)?, &host, &project, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-project-notes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn names_are_readable_stable_and_kept_apart() {
        let name = file_name("resolve", "My Doc / Cut 2").unwrap();
        assert!(name.starts_with("resolve-my-doc-cut-2-") && name.ends_with(".md"), "{name}");
        assert_eq!(name, file_name("resolve", "My Doc / Cut 2").unwrap());
        // Slugs alike, files apart; and the same name in the other editor is another project.
        assert_ne!(file_name("resolve", "My Doc").unwrap(), file_name("resolve", "my doc").unwrap());
        assert_ne!(file_name("resolve", "Doc").unwrap(), file_name("premiere", "Doc").unwrap());
        assert!(file_name("resolve", "∆∆").unwrap().starts_with("resolve-"));
        assert!(file_name("avid", "Doc").is_err() && file_name("resolve", "  ").is_err());
        assert!(!file_name("resolve", "../../etc").unwrap().contains('/'));
    }

    #[test]
    fn notes_round_trip_and_empty_notes_remove_the_file() {
        let dir = temp_dir("round-trip");
        assert_eq!(load_in(&dir, "premiere", "Doc").unwrap(), "");
        save_in(&dir, "premiere", "Doc", "## Brief\n- 60 s cut for Instagram\n").unwrap();
        assert_eq!(load_in(&dir, "premiere", "Doc").unwrap(), "## Brief\n- 60 s cut for Instagram\n");
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap(), "");
        save_in(&dir, "premiere", "Doc", " \n").unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_over_the_cap_are_refused_and_nothing_half_written_is_left() {
        let dir = temp_dir("cap");
        save_in(&dir, "resolve", "Doc", "kept").unwrap();
        let err = save_in(&dir, "resolve", "Doc", &"x".repeat(MAX_NOTES_BYTES + 1)).unwrap_err();
        assert!(err.contains("16 KB"), "{err}");
        assert_eq!(load_in(&dir, "resolve", "Doc").unwrap(), "kept");
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
