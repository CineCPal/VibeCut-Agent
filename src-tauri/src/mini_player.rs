//! The Mini Player (PLAN.md, "Phase 9c"): the main window shrinks into a small bar that floats over
//! other apps, like Apple Music's MiniPlayer. It is the same window and the same webview, so a running
//! chat turn carries on; the frontend shows `MiniPlayer` in place of the full panel.
//!
//! Going mini remembers the full window's frame; expanding puts it back. The bar's own place is saved
//! as `miniPosition` in `window.json` (shared with window_mode.rs) when it expands or the app quits, and
//! used next time. Every change is broadcast as `mini-player`.

use crate::tray::MAIN_WINDOW;
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

pub const MINI_PLAYER_EVENT: &str = "mini-player";
pub const MINI_WIDTH: f64 = 380.0;
pub const MINI_HEIGHT: f64 = 112.0;
/// The full window's limits, as in tauri.conf.json.
const FULL_MIN: (f64, f64) = (380.0, 520.0);
/// The gap from the screen's right edge and the menu bar for a first-time bar.
const MARGIN: f64 = 16.0;
const MENU_BAR: f64 = 38.0;

/// A window's place and size, in logical points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
struct Inner {
    /// The full window's frame while the Mini Player is up; None when it isn't.
    full: Option<Frame>,
    /// Where the bar is now, to be saved.
    position: Option<(f64, f64)>,
}

#[derive(Default)]
pub struct MiniPlayer(Mutex<Inner>);

pub fn is_on(app: &AppHandle) -> bool {
    app.try_state::<MiniPlayer>().and_then(|s| s.0.lock().ok().map(|i| i.full.is_some())).unwrap_or(false)
}

/// The saved place of the bar from `window.json`'s `miniPosition`, if it's a usable one.
pub fn parse_position(value: Option<&serde_json::Value>) -> Option<(f64, f64)> {
    let v = value?;
    let x = v.get("x")?.as_f64()?;
    let y = v.get("y")?.as_f64()?;
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Where a first-time bar goes: the top-right of the screen (`(x, y, width)` in logical points).
pub fn default_position(screen: (f64, f64, f64)) -> (f64, f64) {
    let (x, y, width) = screen;
    (x + width - MINI_WIDTH - MARGIN, y + MENU_BAR)
}

fn frame_of(window: &WebviewWindow) -> Option<Frame> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Frame { x: position.x, y: position.y, width: size.width, height: size.height })
}

fn screen_of(window: &WebviewWindow) -> Option<(f64, f64, f64)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    Some((position.x, position.y, size.width))
}

fn save_position(app: &AppHandle, position: Option<(f64, f64)>) {
    if let Some((x, y)) = position {
        let _ = crate::window_mode::save_field(app, "miniPosition", json!({ "x": x, "y": y }));
    }
}

fn enter(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let full = frame_of(window).ok_or("The window's size couldn't be read")?;
    let saved = parse_position(crate::window_mode::read_file(app).get("miniPosition"));
    let (x, y) = saved.or_else(|| screen_of(window).map(default_position)).unwrap_or((full.x, full.y));
    if let Ok(mut inner) = app.state::<MiniPlayer>().0.lock() {
        inner.full = Some(full);
        inner.position = Some((x, y));
    }
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_min_size(Some(LogicalSize::new(MINI_WIDTH, MINI_HEIGHT)));
    let _ = window.set_size(LogicalSize::new(MINI_WIDTH, MINI_HEIGHT));
    let _ = window.set_position(LogicalPosition::new(x, y));
    crate::window_mode::apply(window, true);
    let _ = window.unminimize();
    let _ = window.show();
    Ok(())
}

fn leave(app: &AppHandle, window: &WebviewWindow) {
    let (full, position) = match app.state::<MiniPlayer>().0.lock() {
        Ok(mut inner) => (inner.full.take(), inner.position.take()),
        Err(_) => (None, None),
    };
    save_position(app, position);
    let _ = window.set_decorations(true);
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(Some(LogicalSize::new(FULL_MIN.0, FULL_MIN.1)));
    if let Some(frame) = full {
        let _ = window.set_size(LogicalSize::new(frame.width.max(FULL_MIN.0), frame.height.max(FULL_MIN.1)));
        let _ = window.set_position(LogicalPosition::new(frame.x, frame.y));
    }
    crate::window_mode::apply(window, crate::window_mode::saved(app));
    let _ = window.show();
    let _ = window.set_focus();
}

/// Goes mini or expands, and announces it (the header, the bar, a hotkey and the tray all come here).
pub fn set(app: &AppHandle, on: bool) -> Result<bool, String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("The main window is gone")?;
    if on != is_on(app) {
        if on {
            enter(app, &window)?;
        } else {
            leave(app, &window);
        }
    }
    crate::tray::sync_mini_player(app, on);
    let _ = app.emit(MINI_PLAYER_EVENT, on);
    Ok(on)
}

/// Follows the bar as the user drags it (`WindowEvent::Moved`, in physical pixels).
pub fn moved(app: &AppHandle, window: &tauri::Window, position: PhysicalPosition<i32>) {
    let Ok(scale) = window.scale_factor() else { return };
    if let Ok(mut inner) = app.state::<MiniPlayer>().0.lock() {
        if inner.full.is_some() {
            let p = position.to_logical::<f64>(scale);
            inner.position = Some((p.x, p.y));
        }
    }
}

/// Saves the bar's place when the app quits with it up.
pub fn save_on_exit(app: &AppHandle) {
    let position = app.state::<MiniPlayer>().0.lock().ok().and_then(|i| i.full.and(i.position));
    save_position(app, position);
}

#[tauri::command]
pub fn mini_player_status(app: AppHandle) -> bool {
    is_on(&app)
}

#[tauri::command]
pub fn set_mini_player(app: AppHandle, on: bool) -> Result<bool, String> {
    set(&app, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_position_reads_back_and_junk_is_ignored() {
        assert_eq!(parse_position(Some(&json!({ "x": 10.5, "y": 40 }))), Some((10.5, 40.0)));
        assert_eq!(parse_position(Some(&json!({ "x": "left", "y": 40 }))), None);
        assert_eq!(parse_position(Some(&json!(null))), None);
        assert_eq!(parse_position(None), None);
    }

    #[test]
    fn a_first_bar_sits_at_the_top_right_under_the_menu_bar() {
        assert_eq!(default_position((0.0, 0.0, 1512.0)), (1512.0 - MINI_WIDTH - MARGIN, MENU_BAR));
        // A second screen to the left of the main one.
        assert_eq!(default_position((-1920.0, 0.0, 1920.0)), (-MINI_WIDTH - MARGIN, MENU_BAR));
    }
}
