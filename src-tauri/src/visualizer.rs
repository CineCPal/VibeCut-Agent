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
//! the one the app started. The app's CSP lets its pages reach the gateway (tauri.conf.json, connect-src) and
//! show the contact strips the gateway streams, which the visualizer turns into `blob:` URLs (img-src).
//!
//! The visualizer's app actions reach the app through the gateway the app started: it checks them and
//! sends each back as a `control` event (gateway.py), which `on_control` carries out. Reveal shows the
//! file in Finder; a playhead move goes to that editor's watcher (`set_playhead`); Cancel asks the main
//! window to stop its chat's turn, as its Stop button does (`CANCEL_TURN_EVENT`, src/lib/agent).

use crate::nle::Host;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const VISUALIZER_WINDOW: &str = "visualizer";
pub const TITLE: &str = "VibeCut Telemetry Studio";
/// Where the gateway listens (gateway.py's default; loopback only).
pub const GATEWAY_ADDR: &str = "127.0.0.1:18765";
const DEV_URL: &str = "http://localhost:5173/";
const BUNDLED_PAGE: &str = "visualizer/index.html";
/// To the main window: stop the turn of the chat whose job the trace names (`{caller}`).
pub const CANCEL_TURN_EVENT: &str = "visualizer-cancel-turn";

/// An app action the gateway checked and handed on.
#[derive(Debug, PartialEq)]
pub enum Control {
    Reveal { path: String },
    Playhead { host: Host, timeline: String, seconds: f64 },
    Cancel { caller: String },
}

/// The action a gateway `control` event asks for, if it's one.
pub fn parse_control(event: &Value) -> Option<Control> {
    let text = |key: &str| event.get(key).and_then(Value::as_str).map(String::from);
    match event.get("action").and_then(Value::as_str)? {
        "REVEAL_IN_FINDER" => Some(Control::Reveal { path: text("path").filter(|p| p.starts_with('/'))? }),
        "SET_NLE_PLAYHEAD" => Some(Control::Playhead {
            host: serde_json::from_value(event.get("host")?.clone()).ok()?,
            timeline: text("timeline").filter(|t| !t.is_empty())?,
            seconds: event.get("seconds").and_then(Value::as_f64).filter(|s| s.is_finite() && *s >= 0.0)?,
        }),
        "CANCEL" => Some(Control::Cancel { caller: text("caller").filter(|c| !c.is_empty())? }),
        _ => None,
    }
}

/// Carries out a `control` event from the app's gateway. Nothing waits on it, so a failure is logged.
pub fn on_control(app: &AppHandle, event: &Value) {
    let Some(control) = parse_control(event) else {
        eprintln!("Telemetry Studio: ignored a control event the app doesn't know: {event}");
        return;
    };
    match control {
        Control::Reveal { path } => {
            if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&path) {
                eprintln!("Telemetry Studio: couldn't show {path} in Finder: {e}");
            }
        }
        Control::Playhead { host, timeline, seconds } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let args = json!({ "timeline": timeline, "time": seconds });
                if let Err(e) = crate::nle::nle_call(app, host, "set_playhead".into(), args).await {
                    eprintln!("Telemetry Studio: couldn't move the playhead: {e}");
                }
            });
        }
        Control::Cancel { caller } => {
            let _ = app.emit_to("main", CANCEL_TURN_EVENT, json!({ "caller": caller }));
        }
    }
}

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
    fn the_apps_csp_lets_the_visualizer_reach_the_gateway_and_show_its_strips() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let directive = |name: &str| -> Vec<&str> {
            csp.split(';')
                .map(str::trim)
                .find(|d| d.starts_with(name))
                .map(|d| d.split_whitespace().skip(1).collect())
                .unwrap_or_default()
        };
        assert!(directive("connect-src").contains(&"http://127.0.0.1:18765"));
        assert!(directive("connect-src").contains(&"ws://127.0.0.1:18765"));
        // The contact strips (VCTB 0x02) are object URLs the page makes from the frames it receives.
        assert!(directive("img-src").contains(&"blob:"));
    }

    #[test]
    fn control_events_become_actions_and_bad_ones_are_dropped() {
        let reveal = json!({"type": "control", "action": "REVEAL_IN_FINDER", "traceId": "t", "path": "/m/b.mov"});
        assert_eq!(parse_control(&reveal), Some(Control::Reveal { path: "/m/b.mov".into() }));
        let playhead = json!({"action": "SET_NLE_PLAYHEAD", "host": "resolve", "timeline": "Cut", "seconds": 12.5});
        assert_eq!(
            parse_control(&playhead),
            Some(Control::Playhead { host: Host::Resolve, timeline: "Cut".into(), seconds: 12.5 })
        );
        assert_eq!(parse_control(&json!({"action": "CANCEL", "caller": "job-7"})), Some(Control::Cancel { caller: "job-7".into() }));
        for bad in [
            json!({"action": "REVEAL_IN_FINDER", "path": "relative.mov"}),
            json!({"action": "SET_NLE_PLAYHEAD", "host": "avid", "timeline": "Cut", "seconds": 1}),
            json!({"action": "SET_NLE_PLAYHEAD", "host": "premiere", "timeline": "", "seconds": 1}),
            json!({"action": "SET_NLE_PLAYHEAD", "host": "premiere", "timeline": "Cut", "seconds": -1}),
            json!({"action": "CANCEL"}),
            json!({"action": "DANCE"}),
        ] {
            assert_eq!(parse_control(&bad), None, "{bad}");
        }
    }

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
