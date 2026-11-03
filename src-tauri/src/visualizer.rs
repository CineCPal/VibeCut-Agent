//! The Telemetry Studio window (Phase 22's visualizer, apps/visualizer), opened from the menu-bar menu as a
//! window of its own, outside a browser. It's an ordinary window: not kept on top of the editors as the
//! main one can be (window_mode.rs), and closing it closes it (the main window only hides). It can go full
//! screen in a Space of its own (the green button, or Globe/Fn-F): an accessory app's windows don't get
//! that by themselves, so `allow_full_screen` marks it a primary full-screen window.
//!
//! The installed app loads the visualizer built into the bundle (`dist/visualizer`, `npm run build`); a dev
//! build loads the visualizer's dev server (`npm --prefix apps/visualizer run dev`, port 5173). Either way it
//! reads the telemetry gateway on 127.0.0.1:18765. Opening the window starts the gateway as a job of the
//! app's own (sidecar.rs) unless one is listening there already (a terminal's), and closing the window stops
//! the one the app started. The app's CSP lets its pages reach the gateway (tauri.conf.json, connect-src).

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const VISUALIZER_WINDOW: &str = "visualizer";
pub const TITLE: &str = "VibeCut Telemetry Studio";
/// Where the gateway listens (gateway.py's default; loopback only).
pub const GATEWAY_ADDR: &str = "127.0.0.1:18765";
const DEV_URL: &str = "http://localhost:5173/";
const BUNDLED_PAGE: &str = "visualizer/index.html";

/// The page the window loads: the visualizer's dev server in a dev build, else the one in the bundle.
pub fn page(dev: bool) -> WebviewUrl {
    if dev {
        WebviewUrl::External(DEV_URL.parse().expect("the dev server's URL"))
    } else {
        WebviewUrl::App(BUNDLED_PAGE.into())
    }
}

/// Whether something is listening on the gateway's port (the app's gateway, or one started elsewhere).
pub fn gateway_listening() -> bool {
    let addr: SocketAddr = GATEWAY_ADDR.parse().expect("the gateway's address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Opens the window, or brings it to the front; starts the gateway first if none is listening. The
/// visualizer reconnects on its own, so it doesn't wait for the gateway to be ready.
pub fn open(app: &AppHandle) -> Result<(), String> {
    if !gateway_listening() {
        if let Err(message) = crate::sidecar::start_gateway(app) {
            eprintln!("Telemetry Studio: the telemetry gateway didn't start: {message}");
        }
    }
    if let Some(window) = app.get_webview_window(VISUALIZER_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, VISUALIZER_WINDOW, page(cfg!(debug_assertions)))
        .title(TITLE)
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("The Telemetry Studio window didn't open: {e}"))?;
    allow_full_screen(&window);
    let _ = window.set_focus();
    Ok(())
}

/// Lets the window go full screen in a Space of its own (macOS), rather than the green button zooming it.
fn allow_full_screen(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let handle = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            let Ok(ptr) = handle.ns_window() else { return };
            // SAFETY: Tauri's NSWindow for this webview window, used on the main thread while it lives.
            let ns = unsafe { &*(ptr as *const NSWindow) };
            ns.setCollectionBehavior(full_screen_behavior(ns.collectionBehavior()));
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// A window's collection behavior with primary full screen on, and what would stop it off.
#[cfg(target_os = "macos")]
fn full_screen_behavior(
    behavior: objc2_app_kit::NSWindowCollectionBehavior,
) -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior as B;
    let mut behavior = behavior;
    behavior.remove(B::FullScreenAuxiliary | B::FullScreenNone | B::CanJoinAllSpaces);
    behavior.insert(B::FullScreenPrimary);
    behavior
}

/// The window has closed: stop the gateway the app started for it.
pub fn closed(app: &AppHandle) {
    crate::sidecar::stop_gateway(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dev_build_loads_the_dev_server_and_the_app_its_bundled_copy() {
        match page(true) {
            WebviewUrl::External(url) => assert_eq!(url.as_str(), "http://localhost:5173/"),
            other => panic!("expected the dev server, got {other:?}"),
        }
        match page(false) {
            WebviewUrl::App(path) => assert_eq!(path, std::path::PathBuf::from("visualizer/index.html")),
            other => panic!("expected the bundled page, got {other:?}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_window_is_made_a_primary_full_screen_window() {
        use objc2_app_kit::NSWindowCollectionBehavior as B;
        let given = B::FullScreenAuxiliary | B::CanJoinAllSpaces | B::Managed;
        let made = full_screen_behavior(given);
        assert!(made.contains(B::FullScreenPrimary | B::Managed));
        assert!(!made.intersects(B::FullScreenAuxiliary | B::FullScreenNone | B::CanJoinAllSpaces));
    }

    #[test]
    fn the_gateway_is_looked_for_on_loopback_only() {
        let addr: SocketAddr = GATEWAY_ADDR.parse().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 18765);
    }
}
