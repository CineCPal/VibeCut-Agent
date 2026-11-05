//! The "VibeCut Agent" panels inside Premiere Pro (a dockable CEP panel) and DaVinci Resolve (a
//! Workflow Integration plugin), `vibecut.host.panels.v1` (docs/specs/host-panels-plan.md, PLAN.md
//! "In-host panels"). A panel is a view and remote control of the app's own chat, B-roll Library and
//! history: the app keeps the agent, the keys and the tools. Adapted from VibeCut's host_chat.rs (removed
//! in its commit 9e056a4). They talk through files, as the B-roll panel does; there is no network port.
//!
//! For each editor, `~/Library/Application Support/VibeCut Agent/host-bridge/chat/<host>/` holds:
//! - `inbox/<id>.json`: one action from the panel, renamed into place. Read here, checked, deleted and
//!   handed to the frontend as a `host-chat-action` event. `open_window` is also answered here.
//! - `state.json`: the chat, draft, model and editor status, written through `host_chat_publish`.
//! - `broll.json`: the B-roll tab, written through `host_chat_broll_publish`.
//! - `analyzer.json`: the Analyze tab (the B-roll Analyzer), written through `host_chat_analyzer_publish`.
//! - `thumbs/s<shot id>.txt`: the B-roll tab's keyframes as `data:` URLs (`host_chat_thumbs`).
//! - `agent-alive.json`: stamped here every second, so the panel knows the app is running.
//! - `panel-alive.json`: stamped by the panel; `host_chat_status` reads its age.
//! - `window.json`: where Resolve's plugin window was (written by the plugin only).
//!
//! The panel makes its folder when it starts, so nothing is written for an editor whose panel has never
//! run. The older B-roll-only panel keeps its own folder and module (`broll_panel.rs`).

use crate::broll_panel::{self, write_atomic, ActionEvent};
use crate::nle::Host;
use crate::state::View;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const ACTION_EVENT: &str = "host-chat-action";
const POLL: Duration = Duration::from_millis(150);
const HEARTBEAT: Duration = Duration::from_secs(1);
const MAX_TEXT_CHARS: usize = 16_000;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PLAYHEAD_SECONDS: f64 = 86_400.0;

/// The models the app offers (`AiChoiceId`, src/types/agent.ts).
const AI_CHOICES: [&str; 4] = ["gemini", "gemini-pro", "claude-code-opus-5-5", "claude-code-sonnet-5-5"];
/// `EffortLevel` and `GeminiEffort` (src/types/agent.ts).
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const GEMINI_EFFORTS: [&str; 3] = ["low", "medium", "high"];
const WINDOW_VIEWS: [&str; 4] = ["chat", "library", "broll", "visualizer"];
/** The Analyzer's number options and their ranges (`useBrollStore`'s LIMITS; the app clamps again). */
const ANALYZER_NUMBERS: [(&str, f64, f64); 7] = [
    ("windowSec", 0.5, 120.0),
    ("maxSegments", 1.0, 20.0),
    ("minGapSec", 0.0, 30.0),
    ("energyWeight", 0.0, 100.0),
    ("relevanceWeight", 0.0, 100.0),
    ("topN", 1.0, 1000.0),
    ("minScore", 0.0, 100.0),
];
const MAX_OPTION_CHARS: usize = 200;
const MAX_MATCH_CHARS: usize = 300;
const MAX_PATH_CHARS: usize = 4096;
/** The most clips, and segments of one clip, an Analyzer action may name (the panel's lists are shorter). */
const MAX_CLIP_INDEX: u64 = 10_000;
const MAX_SEGMENT_INDEX: u64 = 64;

static STARTED: AtomicBool = AtomicBool::new(false);

/// The folder holding every editor's chat folder. `VIBECUT_AGENT_HOST_CHAT_DIR` overrides it (tests and
/// parallel dev builds).
fn chat_root() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_HOST_CHAT_DIR") {
        return Ok(PathBuf::from(custom));
    }
    let home = std::env::var_os("HOME").ok_or("HOME isn't set")?;
    Ok(Path::new(&home).join("Library/Application Support/VibeCut Agent/host-bridge/chat"))
}

/// One editor's chat folder.
pub fn host_dir(host: Host) -> Result<PathBuf, String> {
    Ok(chat_root()?.join(host.as_str()))
}

/// Chat text: trimmed, not empty, at most `MAX_TEXT_CHARS`.
fn text_field(action: &Map<String, Value>) -> Result<String, String> {
    let Some(Value::String(text)) = action.get("text") else {
        return Err("text must be a string".into());
    };
    let text = text.trim();
    if text.is_empty() {
        return Err("text is empty".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("text is longer than {MAX_TEXT_CHARS} characters"));
    }
    Ok(text.into())
}

fn id_field(action: &Map<String, Value>, key: &str) -> Result<String, String> {
    action
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| broll_panel::valid_id(id))
        .map(String::from)
        .ok_or_else(|| format!("{key} must be an id"))
}

fn index_field(action: &Map<String, Value>, key: &str, max: u64) -> Result<u64, String> {
    action.get(key).and_then(Value::as_u64).filter(|i| *i < max).ok_or_else(|| format!("{key} must be a place in the panel's list"))
}

/** A short string option, trimmed only of its ends' newlines: at most `max` characters, no NUL. */
fn short_text(action: &Map<String, Value>, key: &str, max: usize) -> Result<String, String> {
    let Some(Value::String(text)) = action.get(key) else {
        return Err(format!("{key} must be a string"));
    };
    if text.contains('\0') || text.chars().count() > max {
        return Err(format!("{key} must be at most {max} characters"));
    }
    Ok(text.clone())
}

/** An Analyzer option: its key, and a value of that key's kind and range. */
fn analyzer_option(action: &Map<String, Value>, out: &mut Map<String, Value>) -> Result<(), String> {
    let key = action.get("key").and_then(Value::as_str).ok_or("key must be an Analyzer option")?;
    let value = action.get("value").ok_or("value is missing")?;
    let checked = if let Some((_, low, high)) = ANALYZER_NUMBERS.iter().find(|(name, _, _)| *name == key) {
        let n = value.as_f64().filter(|n| n.is_finite() && (*low..=*high).contains(n)).ok_or_else(|| format!("{key} must be from {low} to {high}"))?;
        Value::from(n)
    } else {
        match key {
            "workers" => match value {
                Value::Null => Value::Null,
                _ => Value::from(value.as_u64().filter(|n| (1..=32).contains(n)).ok_or("workers must be from 1 to 32, or automatic")?),
            },
            "topMode" => Value::String(value.as_str().filter(|v| matches!(*v, "all" | "topn" | "threshold")).ok_or("topMode must be all, topn or threshold")?.into()),
            "sequenceOrder" => Value::String(value.as_str().filter(|v| matches!(*v, "score" | "name")).ok_or("sequenceOrder must be score or name")?.into()),
            "sequenceName" | "brief" => {
                let mut holder = Map::new();
                holder.insert(key.into(), value.clone());
                Value::String(short_text(&holder, key, MAX_OPTION_CHARS)?)
            }
            "contentAware" | "dedupe" => Value::Bool(value.as_bool().ok_or_else(|| format!("{key} must be true or false"))?),
            other => return Err(format!("unknown Analyzer option {other:?}")),
        }
    };
    out.insert("key".into(), Value::String(key.into()));
    out.insert("value".into(), checked);
    Ok(())
}

/** A folder to analyze: an absolute path to a folder that exists. */
fn folder_path(action: &Map<String, Value>) -> Result<String, String> {
    let path = short_text(action, "path", MAX_PATH_CHARS)?;
    if !Path::new(&path).is_absolute() || !Path::new(&path).is_dir() {
        return Err("path must be a folder on this Mac".into());
    }
    Ok(path)
}

fn list_field(action: &Map<String, Value>) -> Result<String, String> {
    one_of(action, "list", &["ranked", "matches"])
}

fn one_of(action: &Map<String, Value>, key: &str, allowed: &[&str]) -> Result<String, String> {
    action
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| allowed.contains(v))
        .map(String::from)
        .ok_or_else(|| format!("{key} must be one of {}", allowed.join(", ")))
}

/// Checks one action and rebuilds it from the fields its type allows, so nothing else reaches the
/// frontend. `file_id` must be its id. The B-roll actions are `broll_panel`'s.
pub fn validate_action(value: &Value, file_id: &str) -> Result<Value, String> {
    let Value::Object(action) = value else {
        return Err("an action must be an object".into());
    };
    if action.get("id").and_then(Value::as_str) != Some(file_id) {
        return Err("the action's id must match its file name".into());
    }
    let kind = action.get("type").and_then(Value::as_str).ok_or("type must be a string")?;
    if kind.starts_with("broll_") {
        return broll_panel::validate_action(value, file_id);
    }
    let mut out = Map::new();
    out.insert("id".into(), Value::String(file_id.into()));
    out.insert("type".into(), Value::String(kind.into()));
    match kind {
        "send" | "edit_last" => {
            out.insert("text".into(), Value::String(text_field(action)?));
        }
        "load_chat" => {
            out.insert("chatId".into(), Value::String(id_field(action, "chatId")?));
        }
        "review_decision" => {
            out.insert("cardId".into(), Value::String(id_field(action, "cardId")?));
            out.insert("decision".into(), Value::String(one_of(action, "decision", &["apply", "skip", "all"])?));
        }
        "set_model" => {
            out.insert("aiChoice".into(), Value::String(one_of(action, "aiChoice", &AI_CHOICES)?));
        }
        "set_effort" => {
            out.insert("family".into(), Value::String(one_of(action, "family", &["opus", "sonnet"])?));
            out.insert("effort".into(), Value::String(one_of(action, "effort", &EFFORTS)?));
        }
        "set_gemini_effort" => {
            out.insert("effort".into(), Value::String(one_of(action, "effort", &GEMINI_EFFORTS)?));
        }
        "set_review_edits" => {
            let on = action.get("on").and_then(Value::as_bool).ok_or("on must be true or false")?;
            out.insert("on".into(), Value::Bool(on));
        }
        "queue_remove" => {
            out.insert("queueId".into(), Value::String(id_field(action, "queueId")?));
        }
        "set_playhead" => {
            let seconds = action
                .get("seconds")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && (0.0..=MAX_PLAYHEAD_SECONDS).contains(s))
                .ok_or("seconds must be a time on the timeline")?;
            out.insert("seconds".into(), Value::from(seconds));
        }
        "open_window" => {
            let view = match action.get("view") {
                None | Some(Value::Null) => "chat".to_string(),
                Some(_) => one_of(action, "view", &WINDOW_VIEWS)?,
            };
            out.insert("view".into(), Value::String(view));
        }
        "analyzer_set_folder" => {
            out.insert("path".into(), Value::String(folder_path(action)?));
        }
        "analyzer_set_option" => analyzer_option(action, &mut out)?,
        "analyzer_match" => {
            let query = short_text(action, "query", MAX_MATCH_CHARS)?;
            if query.trim().is_empty() {
                return Err("query is empty".into());
            }
            out.insert("query".into(), Value::String(query.trim().into()));
        }
        "analyzer_toggle_segment" => {
            out.insert("clip".into(), Value::from(index_field(action, "clip", MAX_CLIP_INDEX)?));
            out.insert("segment".into(), Value::from(index_field(action, "segment", MAX_SEGMENT_INDEX)?));
        }
        "analyzer_place" | "analyzer_source" => {
            out.insert("list".into(), Value::String(list_field(action)?));
            out.insert("clip".into(), Value::from(index_field(action, "clip", MAX_CLIP_INDEX)?));
            out.insert("segment".into(), Value::from(index_field(action, "segment", MAX_SEGMENT_INDEX)?));
        }
        "analyzer_reveal" => {
            out.insert("list".into(), Value::String(list_field(action)?));
            out.insert("clip".into(), Value::from(index_field(action, "clip", MAX_CLIP_INDEX)?));
        }
        "usage_refresh" | "analyzer_start" | "analyzer_cancel" | "analyzer_reset_options" | "analyzer_export" | "analyzer_build" | "analyzer_reveal_export" => {}
        "hello" | "stop" | "new_chat" | "retry" | "revert" | "queue_clear" | "queue_resume" | "draft_send" | "draft_discard" => {}
        other => return Err(format!("unknown action type {other:?}")),
    }
    Ok(Value::Object(out))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostActionEvent {
    pub host: Host,
    pub action: Option<Value>,
    pub error: Option<String>,
    pub file_id: String,
}

/// Reads, checks and deletes every action waiting in this editor's inbox, oldest first.
pub fn drain_inbox(dir: &Path, host: Host) -> Vec<HostActionEvent> {
    broll_panel::drain_inbox_with(dir, validate_action)
        .into_iter()
        .map(|ActionEvent { action, error, file_id }| HostActionEvent { host, action, error, file_id })
        .collect()
}

/// The window an `open_window` action asks for.
fn window_view(action: &Value) -> Option<&str> {
    if action.get("type").and_then(Value::as_str) != Some("open_window") {
        return None;
    }
    action.get("view").and_then(Value::as_str)
}

/// Opens (or brings forward) the app's own window, as the menu bar does.
fn open_window(app: &AppHandle, view: &str) {
    let handle = app.clone();
    let view = view.to_string();
    let _ = app.run_on_main_thread(move || {
        let target = match view.as_str() {
            "visualizer" => {
                if let Err(message) = crate::visualizer::open(&handle) {
                    eprintln!("A host panel couldn't open the Telemetry Studio: {message}");
                }
                return;
            }
            "library" => View::Library,
            "broll" => View::Broll,
            _ => View::Chat,
        };
        crate::tray::open_view(&handle, target);
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn serve(app: AppHandle, root: PathBuf) {
    let mut last_beat: Option<Instant> = None;
    loop {
        let beat = last_beat.is_none_or(|t| t.elapsed() >= HEARTBEAT);
        for host in Host::ALL {
            let dir = root.join(host.as_str());
            if !dir.is_dir() {
                continue;
            }
            if beat {
                let stamp = format!("{{\"at\":{},\"pid\":{}}}", now_ms(), std::process::id());
                let _ = write_atomic(&dir, "agent-alive.json", stamp.as_bytes());
            }
            for event in drain_inbox(&dir, host) {
                if let Some(view) = event.action.as_ref().and_then(window_view) {
                    open_window(&app, view);
                }
                let _ = app.emit(ACTION_EVENT, event);
            }
        }
        if beat {
            last_beat = Some(Instant::now());
        }
        std::thread::sleep(POLL);
    }
}

/// Starts watching both editors' inboxes and stamping the app's heartbeat (once per app run).
pub fn start(app: &AppHandle) {
    let Ok(root) = chat_root() else { return };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("host-chat".into()).spawn(move || serve(app, root));
}

/// Writes `name` in `dir` when the panel has run there; false (writing nothing) when it hasn't.
fn publish(dir: &Path, name: &str, value: &Value) -> Result<bool, String> {
    if !dir.is_dir() {
        return Ok(false);
    }
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("The panel's {name} is too large"));
    }
    write_atomic(dir, name, &bytes)?;
    Ok(true)
}

/// Writes this editor's `state.json`.
#[tauri::command]
pub fn host_chat_publish(host: Host, state: Value) -> Result<bool, String> {
    publish(&host_dir(host)?, "state.json", &state)
}

/// Writes this editor's `broll.json`.
#[tauri::command]
pub fn host_chat_broll_publish(host: Host, file: Value) -> Result<bool, String> {
    publish(&host_dir(host)?, "broll.json", &file)
}

/// Writes this editor's `analyzer.json`.
#[tauri::command]
pub fn host_chat_analyzer_publish(host: Host, file: Value) -> Result<bool, String> {
    publish(&host_dir(host)?, "analyzer.json", &file)
}

/// Writes the thumbnails of these shots that this editor's panel doesn't have yet; returns the shots
/// that have one.
#[tauri::command]
pub async fn host_chat_thumbs(app: AppHandle, host: Host, shot_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    tauri::async_runtime::spawn_blocking(move || broll_panel::write_thumbs(&app, &host_dir(host)?, &shot_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether this editor's panel is open now.
#[tauri::command]
pub fn host_chat_status(host: Host) -> Result<bool, String> {
    Ok(broll_panel::panel_attached(&host_dir(host)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-host-chat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("inbox")).unwrap();
        dir
    }

    fn check(action: Value) -> Result<Value, String> {
        let id = action["id"].as_str().unwrap_or("a1").to_string();
        validate_action(&action, &id)
    }

    #[test]
    fn chat_actions_keep_only_their_fields() {
        assert_eq!(
            check(json!({"id": "a1", "type": "send", "text": "  tighten the intro ", "images": ["x"], "path": "/etc"})).unwrap(),
            json!({"id": "a1", "type": "send", "text": "tighten the intro"})
        );
        assert_eq!(check(json!({"id": "a2", "type": "edit_last", "text": "again"})).unwrap()["text"], "again");
        assert_eq!(check(json!({"id": "a3", "type": "load_chat", "chatId": "c-9", "x": 1})).unwrap(), json!({"id": "a3", "type": "load_chat", "chatId": "c-9"}));
        assert_eq!(
            check(json!({"id": "a4", "type": "review_decision", "cardId": "m1", "decision": "all"})).unwrap(),
            json!({"id": "a4", "type": "review_decision", "cardId": "m1", "decision": "all"})
        );
        assert_eq!(check(json!({"id": "a5", "type": "set_model", "aiChoice": "claude-code-opus-5-5"})).unwrap()["aiChoice"], "claude-code-opus-5-5");
        assert_eq!(
            check(json!({"id": "a6", "type": "set_effort", "family": "sonnet", "effort": "xhigh"})).unwrap(),
            json!({"id": "a6", "type": "set_effort", "family": "sonnet", "effort": "xhigh"})
        );
        assert_eq!(check(json!({"id": "a7", "type": "set_gemini_effort", "effort": "low"})).unwrap()["effort"], "low");
        assert_eq!(check(json!({"id": "a8", "type": "set_review_edits", "on": true})).unwrap()["on"], true);
        assert_eq!(check(json!({"id": "a9", "type": "queue_remove", "queueId": "q1"})).unwrap()["queueId"], "q1");
        assert_eq!(check(json!({"id": "b1", "type": "set_playhead", "seconds": 12.5})).unwrap()["seconds"], 12.5);
        assert_eq!(check(json!({"id": "b2", "type": "open_window"})).unwrap(), json!({"id": "b2", "type": "open_window", "view": "chat"}));
        assert_eq!(check(json!({"id": "b3", "type": "open_window", "view": "visualizer"})).unwrap()["view"], "visualizer");
        for kind in ["hello", "stop", "new_chat", "retry", "revert", "queue_clear", "queue_resume", "draft_send", "draft_discard"] {
            assert_eq!(check(json!({"id": "c1", "type": kind, "text": "dropped"})).unwrap(), json!({"id": "c1", "type": kind}));
        }
    }

    #[test]
    fn bad_chat_actions_are_refused() {
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        for bad in [
            json!({"id": "a1", "type": "send", "text": "   "}),
            json!({"id": "a1", "type": "send", "text": long}),
            json!({"id": "a1", "type": "send"}),
            json!({"id": "a1", "type": "load_chat", "chatId": "../x"}),
            json!({"id": "a1", "type": "review_decision", "cardId": "m1", "decision": "maybe"}),
            json!({"id": "a1", "type": "set_model", "aiChoice": "gpt"}),
            json!({"id": "a1", "type": "set_effort", "family": "haiku", "effort": "low"}),
            json!({"id": "a1", "type": "set_gemini_effort", "effort": "off"}),
            json!({"id": "a1", "type": "set_review_edits", "on": "yes"}),
            json!({"id": "a1", "type": "set_playhead", "seconds": -1}),
            json!({"id": "a1", "type": "set_playhead", "seconds": 90_000}),
            json!({"id": "a1", "type": "open_window", "view": "settings"}),
            json!({"id": "a1", "type": "rm_rf"}),
            json!(["not", "an", "object"]),
        ] {
            assert!(validate_action(&bad, "a1").is_err(), "{bad} should be refused");
        }
        assert!(validate_action(&json!({"id": "a1", "type": "stop"}), "a2").is_err(), "the id must match the file");
    }

    #[test]
    fn analyzer_actions_keep_only_their_fields() {
        let folder = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(
            check(json!({"id": "a1", "type": "analyzer_set_folder", "path": folder, "x": 1})).unwrap(),
            json!({"id": "a1", "type": "analyzer_set_folder", "path": folder})
        );
        assert_eq!(
            check(json!({"id": "a2", "type": "analyzer_set_option", "key": "windowSec", "value": 2.5, "path": "/etc"})).unwrap(),
            json!({"id": "a2", "type": "analyzer_set_option", "key": "windowSec", "value": 2.5})
        );
        assert_eq!(check(json!({"id": "a3", "type": "analyzer_set_option", "key": "workers", "value": null})).unwrap()["value"], Value::Null);
        assert_eq!(check(json!({"id": "a4", "type": "analyzer_set_option", "key": "topMode", "value": "topn"})).unwrap()["value"], "topn");
        assert_eq!(check(json!({"id": "a5", "type": "analyzer_set_option", "key": "contentAware", "value": true})).unwrap()["value"], true);
        assert_eq!(check(json!({"id": "a6", "type": "analyzer_set_option", "key": "brief", "value": "city at night"})).unwrap()["value"], "city at night");
        assert_eq!(check(json!({"id": "a7", "type": "analyzer_match", "query": "  a dog  "})).unwrap()["query"], "a dog");
        assert_eq!(
            check(json!({"id": "a8", "type": "analyzer_place", "list": "matches", "clip": 2, "segment": 0, "path": "/x"})).unwrap(),
            json!({"id": "a8", "type": "analyzer_place", "list": "matches", "clip": 2, "segment": 0})
        );
        assert_eq!(check(json!({"id": "a9", "type": "analyzer_toggle_segment", "clip": 0, "segment": 3})).unwrap()["segment"], 3);
        assert_eq!(check(json!({"id": "b1", "type": "analyzer_reveal", "list": "ranked", "clip": 1})).unwrap()["clip"], 1);
        for kind in ["usage_refresh", "analyzer_start", "analyzer_cancel", "analyzer_reset_options", "analyzer_export", "analyzer_build", "analyzer_reveal_export"] {
            assert_eq!(check(json!({"id": "c1", "type": kind, "path": "/etc"})).unwrap(), json!({"id": "c1", "type": kind}));
        }
    }

    #[test]
    fn bad_analyzer_actions_are_refused() {
        for bad in [
            json!({"id": "a1", "type": "analyzer_set_folder", "path": "relative/folder"}),
            json!({"id": "a1", "type": "analyzer_set_folder", "path": "/no/such/folder/anywhere"}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "windowSec", "value": 500}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "workers", "value": 0}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "topMode", "value": "best"}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "sequenceName", "value": "x".repeat(201)}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "contentAware", "value": "yes"}),
            json!({"id": "a1", "type": "analyzer_set_option", "key": "folder", "value": "/etc"}),
            json!({"id": "a1", "type": "analyzer_match", "query": "   "}),
            json!({"id": "a1", "type": "analyzer_place", "list": "pool", "clip": 0, "segment": 0}),
            json!({"id": "a1", "type": "analyzer_place", "list": "ranked", "clip": -1, "segment": 0}),
            json!({"id": "a1", "type": "analyzer_source", "list": "ranked", "clip": 0, "segment": 99}),
            json!({"id": "a1", "type": "analyzer_reveal", "list": "ranked", "path": "/etc/passwd"}),
        ] {
            assert!(validate_action(&bad, "a1").is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn b_roll_actions_are_the_b_roll_panels() {
        assert_eq!(
            check(json!({"id": "a1", "type": "broll_search", "query": " dusk ", "text": "x"})).unwrap(),
            json!({"id": "a1", "type": "broll_search", "query": "dusk"})
        );
        assert_eq!(check(json!({"id": "a2", "type": "broll_place", "key": "k1"})).unwrap()["key"], "k1");
        assert!(check(json!({"id": "a3", "type": "broll_import", "keys": []})).is_err());
        assert!(check(json!({"id": "a4", "type": "broll_nope"})).is_err());
    }

    #[test]
    fn the_inbox_is_drained_oldest_first_with_its_host() {
        let dir = temp_dir("drain");
        std::fs::write(dir.join("inbox/a1.json"), r#"{"id":"a1","type":"open_window","view":"library"}"#).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("inbox/a2.json"), r#"{"id":"a2","type":"send","text":""}"#).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("inbox/a3.json"), r#"{"id":"a3","type":"stop"}"#).unwrap();
        std::fs::write(dir.join("inbox/.a4.json.tmp"), "{}").unwrap();
        let events = drain_inbox(&dir, Host::Resolve);
        assert_eq!(events.iter().map(|e| e.file_id.as_str()).collect::<Vec<_>>(), ["a1", "a2", "a3"]);
        assert!(events.iter().all(|e| e.host == Host::Resolve));
        assert_eq!(window_view(events[0].action.as_ref().unwrap()), Some("library"));
        assert!(events[1].error.as_deref().unwrap().contains("empty"));
        assert_eq!(window_view(events[2].action.as_ref().unwrap()), None);
        let left: Vec<_> = std::fs::read_dir(dir.join("inbox")).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "the hidden half-written file stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_or_oversized_action_is_refused_and_its_target_kept() {
        let dir = temp_dir("symlink");
        let target = dir.join("target.json");
        std::fs::write(&target, r#"{"id":"a1","type":"stop"}"#).unwrap();
        std::os::unix::fs::symlink(&target, dir.join("inbox/a1.json")).unwrap();
        let big = format!(r#"{{"id":"a2","type":"send","text":"{}"}}"#, "x".repeat(70 * 1024));
        std::fs::write(dir.join("inbox/a2.json"), big).unwrap();
        let events = drain_inbox(&dir, Host::Premiere);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.action.is_none()));
        assert!(target.is_file(), "the symlink's target is never touched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publishing_writes_only_where_a_panel_has_run() {
        let dir = temp_dir("publish");
        assert!(!publish(&dir.join("never-ran"), "state.json", &json!({"v": 1})).unwrap());
        assert!(!dir.join("never-ran").exists());
        assert!(publish(&dir, "state.json", &json!({"v": 1})).unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("state.json")).unwrap(), r#"{"v":1}"#);
        let huge = Value::String("x".repeat(MAX_FILE_BYTES));
        assert!(publish(&dir, "broll.json", &huge).is_err());
        assert!(!dir.join("broll.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_editor_has_its_own_folder() {
        let root = chat_root().unwrap();
        assert_eq!(host_dir(Host::Premiere).unwrap(), root.join("premiere"));
        assert_eq!(host_dir(Host::Resolve).unwrap(), root.join("resolve"));
    }
}
