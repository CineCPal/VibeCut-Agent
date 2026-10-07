//! "Open at login" (Settings → Window): a LaunchAgent in ~/Library/LaunchAgents, written and removed
//! by tauri-plugin-autostart, that starts the installed app when the user logs in. The app launches
//! with `--at-login`, so it stays in the menu bar; opened by hand, the installed app shows its window.
//! Off unless the user turns it on.
//!
//! Only the installed app (a release build, `npm run install-app`) may register itself: a dev build's
//! LaunchAgent would point at `target/debug`, which the next rebuild replaces or removes.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// The argument the LaunchAgent starts the app with.
pub const AT_LOGIN_ARG: &str = "--at-login";

/// Whether the window opens at launch: for the installed app opened by hand, not at login, and not for
/// a dev build (`tauri dev` starts it in the menu bar, as always).
pub fn shows_window_at_launch(debug_build: bool, mut args: impl Iterator<Item = String>) -> bool {
    !debug_build && !args.any(|a| a == AT_LOGIN_ARG)
}

pub const DEV_BUILD_REFUSAL: &str = "Only the installed app can open at login (npm run install-app).";

/// Why this build can't open at login, or None when it can.
pub fn refusal(debug_build: bool) -> Option<&'static str> {
    debug_build.then_some(DEV_BUILD_REFUSAL)
}

#[tauri::command]
pub fn open_at_login_status(app: AppHandle) -> Result<bool, String> {
    if let Some(why) = refusal(cfg!(debug_assertions)) {
        return Err(why.into());
    }
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_open_at_login(app: AppHandle, on: bool) -> Result<bool, String> {
    if let Some(why) = refusal(cfg!(debug_assertions)) {
        return Err(why.into());
    }
    let manager = app.autolaunch();
    if on { manager.enable() } else { manager.disable() }.map_err(|e| e.to_string())?;
    manager.is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_release_build_may_open_at_login() {
        assert_eq!(refusal(true), Some(DEV_BUILD_REFUSAL));
        assert_eq!(refusal(false), None);
    }

    #[test]
    fn the_installed_app_shows_its_window_unless_started_at_login() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert!(shows_window_at_launch(false, args(&["/Apps/VibeCut Agent.app/Contents/MacOS/vibecut-agent"])));
        assert!(!shows_window_at_launch(false, args(&["vibecut-agent", AT_LOGIN_ARG])));
        assert!(!shows_window_at_launch(true, args(&["vibecut-agent"])));
    }
}
