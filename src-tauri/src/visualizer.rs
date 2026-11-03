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
//! Premiere's docked Telemetry Studio panel (src-premiere-panel/studio, PLAN.md "The Telemetry Studio in
//! Premiere's panel") reads the same gateway, with the panel key from gateway.json. While it's open it stamps
//! `<appData>/telemetry/studio-panel-alive.json` every 2 s; `watch_studio_panel` starts the gateway while
//! that stamp is fresh and stops it once neither the panel nor this window wants it.
//!
//! The visualizer's app actions reach the app through the gateway the app started: it checks them and
//! sends each back as a `control` event (gateway.py), which `on_control` carries out. Reveal shows the
//! file in Finder; a playhead move goes to that editor's watcher (`set_playhead`); Cancel asks the main
//! window to stop its chat's turn, as its Stop button does (`CANCEL_TURN_EVENT`, src/lib/agent).

use crate::nle::Host;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const VISUALIZER_WINDOW: &str = "visualizer";
pub const TITLE: &str = "VibeCut Telemetry Studio";
/// Where the gateway listens (gateway.py's default; loopback only).
pub const GATEWAY_ADDR: &str = "127.0.0.1:18765";
const DEV_URL: &str = "http://localhost:5173/";
/// The Premiere panel's heartbeat, beside the journals (cepPanel.ts `ALIVE_FILE`).
pub const STUDIO_PANEL_ALIVE: &str = "studio-panel-alive.json";
/// The panel stamps every 2 s; a stamp this old means it's closed (or Premiere quit).
const STUDIO_PANEL_WITHIN_S: f64 = 6.0;
const STUDIO_PANEL_POLL: Duration = Duration::from_secs(2);
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

/// The window has closed: stop the gateway the app started for it, unless Premiere's panel still reads it.
pub fn closed(app: &AppHandle) {
    if !studio_panel_alive_now(app) {
        crate::sidecar::stop_gateway(app);
    }
}

/// Whether the panel's heartbeat in `telemetry` was stamped (its `time`, in seconds) within
/// `STUDIO_PANEL_WITHIN_S` of `now`.
pub fn studio_panel_alive(telemetry: &Path, now: f64) -> bool {
    let Ok(text) = std::fs::read_to_string(telemetry.join(STUDIO_PANEL_ALIVE)) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("time").and_then(Value::as_f64))
        .is_some_and(|stamp| (now - stamp).abs() <= STUDIO_PANEL_WITHIN_S)
}

fn studio_panel_alive_now(app: &AppHandle) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    app.path().app_data_dir().is_ok_and(|dir| studio_panel_alive(&dir.join("telemetry"), now))
}

/// What to do with the app's gateway, given who wants it. Start: the panel is open and nothing listens.
/// Stop: neither the panel nor the window wants it, and it's the app's own.
#[derive(Debug, PartialEq, Eq)]
pub enum GatewayNeed {
    Start,
    Stop,
    Keep,
}

pub fn gateway_need(panel_alive: bool, window_open: bool, app_gateway_running: bool, listening: bool) -> GatewayNeed {
    if panel_alive && !app_gateway_running && !listening {
        GatewayNeed::Start
    } else if !panel_alive && !window_open && app_gateway_running {
        GatewayNeed::Stop
    } else {
        GatewayNeed::Keep
    }
}

/// Checks the Premiere panel's heartbeat every 2 s for as long as the app runs (lib.rs `setup`).
pub fn watch_studio_panel(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(STUDIO_PANEL_POLL);
        let running = crate::sidecar::gateway_running(&app);
        let need = gateway_need(
            studio_panel_alive_now(&app),
            app.get_webview_window(VISUALIZER_WINDOW).is_some(),
            running,
            !running && gateway_listening(),
        );
        match need {
            GatewayNeed::Start => {
                if let Err(message) = crate::sidecar::start_gateway(&app) {
                    eprintln!("Telemetry Studio panel: the telemetry gateway didn't start: {message}");
                }
            }
            GatewayNeed::Stop => crate::sidecar::stop_gateway(&app),
            GatewayNeed::Keep => {}
        }
    });
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
    fn the_studio_panels_heartbeat_keeps_the_gateway_running() {
        let dir = std::env::temp_dir().join(format!("vca-studio-panel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!studio_panel_alive(&dir, 1000.0));
        std::fs::write(dir.join(STUDIO_PANEL_ALIVE), r#"{"time": 1000.5, "pid": 7}"#).unwrap();
        assert!(studio_panel_alive(&dir, 1003.0));
        assert!(!studio_panel_alive(&dir, 1010.0));
        std::fs::write(dir.join(STUDIO_PANEL_ALIVE), "not json").unwrap();
        assert!(!studio_panel_alive(&dir, 1000.0));
        std::fs::remove_dir_all(dir).unwrap();

        // (panel alive, window open, the app's gateway running, something else listening)
        assert_eq!(gateway_need(true, false, false, false), GatewayNeed::Start);
        assert_eq!(gateway_need(true, false, false, true), GatewayNeed::Keep, "a terminal's gateway serves it");
        assert_eq!(gateway_need(true, false, true, false), GatewayNeed::Keep);
        assert_eq!(gateway_need(false, true, true, false), GatewayNeed::Keep, "the window still reads it");
        assert_eq!(gateway_need(false, false, true, false), GatewayNeed::Stop);
        assert_eq!(gateway_need(false, false, false, true), GatewayNeed::Keep, "not the app's to stop");
    }

    #[test]
    fn the_gateway_is_looked_for_on_loopback_only() {
        let addr: SocketAddr = GATEWAY_ADDR.parse().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 18765);
    }
}
