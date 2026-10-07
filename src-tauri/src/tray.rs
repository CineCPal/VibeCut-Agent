//! The menu-bar (tray) icon. VibeCut Agent launches with no window and no Dock icon; this menu is how
//! the user opens a view. Each "open" item parks the view in `AppState`, shows the main window and
//! emits `navigate` so an already-loaded frontend switches immediately.
//! Adapted from VibeCut's `src-tauri/src/background.rs`.

use crate::state::{AppState, View};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const MAIN_WINDOW: &str = "main";
pub const NAVIGATE_EVENT: &str = "navigate";

const ID_CHAT: &str = "tray-chat";
const ID_BROLL: &str = "tray-broll";
const ID_SETTINGS: &str = "tray-settings";
const ID_ABOUT: &str = "tray-about";
const ID_QUIT: &str = "tray-quit";
const ID_ON_TOP: &str = "tray-on-top";
const ID_MINI: &str = "tray-mini";

/// The tray's "Keep on Top of Editors" item, so a change made elsewhere ticks or unticks it.
#[derive(Default)]
pub struct KeepOnTopItem(Mutex<Option<CheckMenuItem<Wry>>>);

/// The tray's "Mini Player" item (Phase 9c), ticked while the window is the bar.
#[derive(Default)]
pub struct MiniPlayerItem(Mutex<Option<CheckMenuItem<Wry>>>);

pub fn sync_mini_player(app: &AppHandle, on: bool) {
    if let Some(item) = app.try_state::<MiniPlayerItem>() {
        if let Some(item) = item.0.lock().ok().and_then(|i| i.clone()) {
            let _ = item.set_checked(on);
        }
    }
}

pub fn sync_keep_on_top(app: &AppHandle, on: bool) {
    if let Some(item) = app.try_state::<KeepOnTopItem>() {
        if let Some(item) = item.0.lock().ok().and_then(|i| i.clone()) {
            let _ = item.set_checked(on);
        }
    }
}

/// The view a tray menu item opens, or `None` for items that don't open one (Quit).
pub fn view_for_menu_id(id: &str) -> Option<View> {
    match id {
        ID_CHAT => Some(View::Chat),
        ID_BROLL => Some(View::Broll),
        ID_SETTINGS => Some(View::Settings),
        ID_ABOUT => Some(View::About),
        _ => None,
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shows the main window on `view`, full size (it leaves the Mini Player).
pub fn open_view(app: &AppHandle, view: View) {
    if crate::mini_player::is_on(app) {
        let _ = crate::mini_player::set(app, false);
    }
    app.state::<AppState>().set_pending_view(view);
    show_main(app);
    let _ = app.emit_to(MAIN_WINDOW, NAVIGATE_EVENT, view);
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let chat = MenuItem::with_id(handle, ID_CHAT, "Open Agent Panel", true, None::<&str>)?;
    let broll = MenuItem::with_id(handle, ID_BROLL, "Open B-Roll Analyzer", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, ID_SETTINGS, "Settings…", true, None::<&str>)?;
    let about = MenuItem::with_id(handle, ID_ABOUT, "About This App", true, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(handle, ID_ON_TOP, "Keep on Top of Editors", true, crate::window_mode::saved(handle), None::<&str>)?;
    if let Ok(mut slot) = app.state::<KeepOnTopItem>().0.lock() {
        *slot = Some(on_top.clone());
    }
    let mini = CheckMenuItem::with_id(handle, ID_MINI, "Mini Player", true, false, Some("Alt+CmdOrCtrl+M"))?;
    if let Ok(mut slot) = app.state::<MiniPlayerItem>().0.lock() {
        *slot = Some(mini.clone());
    }
    let quit = MenuItem::with_id(handle, ID_QUIT, "Quit VibeCut Agent", true, None::<&str>)?;
    let menu = Menu::with_items(
        handle,
        &[
            &chat,
            &broll,
            &mini,
            &PredefinedMenuItem::separator(handle)?,
            &on_top,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &about,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("vibecut-agent")
        .tooltip("VibeCut Agent")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == ID_QUIT {
                app.exit(0);
            } else if id == ID_ON_TOP {
                // The check item has already flipped itself; its new state is the choice.
                let on = !crate::window_mode::saved(app);
                let _ = crate::window_mode::set(app, on);
            } else if id == ID_MINI {
                // As for Keep on Top: the item has flipped itself; the window follows.
                let on = !crate::mini_player::is_on(app);
                let _ = crate::mini_player::set(app, on);
            } else if let Some(view) = view_for_menu_id(id) {
                open_view(app, view);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_map_to_views() {
        assert_eq!(view_for_menu_id(ID_CHAT), Some(View::Chat));
        assert_eq!(view_for_menu_id(ID_BROLL), Some(View::Broll));
        assert_eq!(view_for_menu_id(ID_SETTINGS), Some(View::Settings));
        assert_eq!(view_for_menu_id(ID_ABOUT), Some(View::About));
        assert_eq!(view_for_menu_id(ID_QUIT), None);
        assert_eq!(view_for_menu_id(ID_MINI), None, "Mini Player switches the window, it opens no view");
        assert_eq!(view_for_menu_id("unknown"), None);
    }
}
