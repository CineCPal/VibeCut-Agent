//! The Analyze tab's segment preview (Phase 10): lets the webview's `<video>` read one clip through the
//! asset protocol. The config's asset scope is empty, so nothing is readable until a clip the user
//! chose to preview is checked here: an absolute path to an existing file with a video extension
//! (the same list as `vibecut_agent/broll/analyzer.py`'s `VIDEO_EXTENSIONS`). Nothing is copied or sent.

use std::path::Path;
use tauri::{AppHandle, Manager};

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "avi", "mxf", "mkv", "mts", "m2ts", "ts", "webm", "wmv", "flv", "mpg", "mpeg", "3gp",
];

/// Why `path` can't be previewed, or `None` when it can.
pub fn preview_refusal(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return Some("The clip's path must be absolute".into());
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return Some(format!("Not a video file: {}", path.display()));
    }
    if !path.is_file() {
        return Some(format!("The clip isn't there any more: {}", path.display()));
    }
    None
}

/// Allows the asset protocol to read this one clip, after `preview_refusal`'s checks.
#[tauri::command]
pub fn broll_preview_allow(app: AppHandle, path: String) -> Result<(), String> {
    let file = Path::new(&path);
    if let Some(reason) = preview_refusal(file) {
        return Err(reason);
    }
    app.asset_protocol_scope().allow_file(file).map_err(|e| format!("Couldn't allow the preview: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_absolute_video_files_are_allowed() {
        let dir = std::env::temp_dir().join(format!("vca-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("Shot 01.MOV");
        let text = dir.join("notes.txt");
        std::fs::write(&clip, b"x").unwrap();
        std::fs::write(&text, b"x").unwrap();

        assert_eq!(preview_refusal(&clip), None);
        assert!(preview_refusal(&text).unwrap().starts_with("Not a video file"));
        assert!(preview_refusal(&dir.join("gone.mp4")).unwrap().starts_with("The clip isn't there"));
        assert!(preview_refusal(Path::new("relative.mp4")).unwrap().contains("absolute"));
        assert!(preview_refusal(&dir).unwrap().starts_with("Not a video file"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
