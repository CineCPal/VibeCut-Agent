//! "Keep on Top of Editors": the main window floats above other apps' windows and, on macOS, joins every
//! Space, including the one a full-screen Premiere Pro or DaVinci Resolve occupies. Floating alone isn't
//! enough there: a full-screen app has its own Space, so the window also needs the `CanJoinAllSpaces` and
//! `FullScreenAuxiliary` collection behaviors. VibeCut Agent is an accessory (menu-bar) app, which macOS
//! lets put auxiliary windows over a full-screen app.
//!
//! On by default. The choice is saved as `window.json` in the app's config folder, applied in `setup`
//! before the window is first shown, and changed from the header's pin, Settings or the tray menu
//! (every change is broadcast as `keep-on-top`).

use crate::tray::MAIN_WINDOW;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const KEEP_ON_TOP_EVENT: &str = "keep-on-top";
const FILE: &str = "window.json";

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

/// The saved choice from `window.json`'s text; on unless it says otherwise.
pub fn parse_keep_on_top(text: Option<&str>) -> bool {
    text.and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.get("keepOnTop").and_then(serde_json::Value::as_bool))
        .unwrap_or(true)
}

pub fn saved(app: &AppHandle) -> bool {
    let text = file(app).and_then(|f| std::fs::read_to_string(f).ok());
    parse_keep_on_top(text.as_deref())
}

/// `window.json` as saved, or an empty object.
pub fn read_file(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Sets one field of `window.json`, keeping the others (the Mini Player keeps its place there too).
pub fn save_field(app: &AppHandle, key: &str, value: serde_json::Value) -> Result<(), String> {
    let path = file(app).ok_or("The app's config folder is unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut saved = read_file(app);
    saved.insert(key.to_string(), value);
    std::fs::write(path, serde_json::Value::Object(saved).to_string()).map_err(|e| e.to_string())
}

fn save(app: &AppHandle, on: bool) -> Result<(), String> {
    save_field(app, "keepOnTop", serde_json::Value::Bool(on))
}

/// Floats the window (or not) and lets it into full-screen Spaces (macOS).
pub fn apply(window: &WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
    let _ = window.set_visible_on_all_workspaces(on);
    #[cfg(target_os = "macos")]
    {
        let handle = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as B};
            let Ok(ptr) = handle.ns_window() else { return };
            // SAFETY: Tauri's NSWindow for this webview window, used on the main thread while it lives.
            let ns = unsafe { &*(ptr as *const NSWindow) };
            let mut behavior = ns.collectionBehavior();
            if on {
                behavior.remove(B::MoveToActiveSpace);
                behavior.insert(B::CanJoinAllSpaces | B::FullScreenAuxiliary);
            } else {
                behavior.remove(B::CanJoinAllSpaces | B::FullScreenAuxiliary);
            }
            ns.setCollectionBehavior(behavior);
        });
    }
}

/// Applies the saved choice at launch.
pub fn setup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        apply(&window, saved(app));
    }
}

/// Saves, applies and announces a change (the header, Settings and the tray all go through here).
pub fn set(app: &AppHandle, on: bool) -> Result<bool, String> {
    save(app, on)?;
    // The Mini Player always floats; the choice applies again when it expands (mini_player.rs).
    if let Some(window) = app.get_webview_window(MAIN_WINDOW).filter(|_| !crate::mini_player::is_on(app)) {
        apply(&window, on);
    }
    crate::tray::sync_keep_on_top(app, on);
    let _ = app.emit(KEEP_ON_TOP_EVENT, on);
    Ok(on)
}

#[tauri::command]
pub fn keep_on_top_status(app: AppHandle) -> bool {
    saved(&app)
}

#[tauri::command]
pub fn set_keep_on_top(app: AppHandle, on: bool) -> Result<bool, String> {
    set(&app, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_on_top_is_on_unless_saved_off() {
        assert!(parse_keep_on_top(None));
        assert!(parse_keep_on_top(Some("not json")));
        assert!(parse_keep_on_top(Some(r#"{"keepOnTop": true}"#)));
        assert!(!parse_keep_on_top(Some(r#"{"keepOnTop": false}"#)));
    }
}
