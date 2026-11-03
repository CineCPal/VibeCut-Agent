//! The Telemetry Studio window (Phase 22's visualizer, apps/visualizer), opened from the menu-bar menu as a
//! window of its own, outside a browser. It's an ordinary window: not kept on top of the editors as the
//! main one can be (window_mode.rs), and closing it closes it (the main window only hides).
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
    let _ = window.set_focus();
    Ok(())
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

    #[test]
    fn the_gateway_is_looked_for_on_loopback_only() {
        let addr: SocketAddr = GATEWAY_ADDR.parse().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 18765);
    }
}
