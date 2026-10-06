//! Keeps a watcher running for each editor and relays what it sees (PLAN.md, Phase 3).
//!
//! - Premiere Pro: `premiere-watch`, run by uv, talks to VibeCut Agent's panel inside Premiere
//!   through request files (`src-premiere-panel`, installed by `premiere_panel.rs`).
//! - DaVinci Resolve: `resolve-watch`, run by Resolve's own Python, talks to Resolve's scripting API.
//!
//! A watcher never exits on its own while the app runs: it probes its editor every couple of seconds
//! and reports each change as a `state` event (see `vibecut_agent/nle/watch.py`), which is relayed to
//! the frontend as `nle-state`. Its `reason` (`connected`, `restarted`, `project_changed`...) is how
//! the app knows to re-sync. If a watcher process dies anyway, it is started again with backoff; after
//! `GIVE_UP_AFTER` starts in a row that never reported `ready` it stays down until `nle_reconnect`.
//!
//! `nle_call` sends one read to a watcher (`status`, `read_timeline`) and waits for its `reply`.

use crate::sidecar::{
    lock, package_dir, pump, python_root, resolve_python, start_child, uv_environment, Launch, SidecarJob,
    SidecarJobs,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const STATE_EVENT: &str = "nle-state";
/// How long `nle_call` waits for a reply. The watcher gives Premiere 25 s for its longest read.
const CALL_TIMEOUT: Duration = Duration::from_secs(35);
/// A rebuild imports a whole new timeline (Premiere's XML import alone may take 170 s; Phase 6b).
const REBUILD_TIMEOUT: Duration = Duration::from_secs(200);

/// How long a call may take before the app stops waiting for it.
pub fn call_timeout(command: &str) -> Duration {
    if command == "rebuild" {
        REBUILD_TIMEOUT
    } else {
        CALL_TIMEOUT
    }
}
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const GIVE_UP_AFTER: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Host {
    Premiere,
    Resolve,
}

impl Host {
    pub const ALL: [Host; 2] = [Host::Premiere, Host::Resolve];

    fn job_id(self) -> &'static str {
        match self {
            Host::Premiere => "nle-premiere",
            Host::Resolve => "nle-resolve",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Host::Premiere => "premiere-watch",
            Host::Resolve => "resolve-watch",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Host::Premiere => "Premiere Pro",
            Host::Resolve => "DaVinci Resolve",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NleStatus {
    /// The watcher is starting (or restarting).
    Connecting,
    Connected,
    /// The watcher runs, but the editor isn't reachable; `message` says why.
    Disconnected,
    /// The watcher itself failed; `message` says why.
    Error,
    /// This editor can't be watched on this machine (e.g. Resolve isn't installed).
    Unavailable,
}

/// What the frontend's `useNleStateStore` holds for one editor (`NleState` in src/types/nle.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NleState {
    pub host: Host,
    pub status: NleStatus,
    pub message: Option<String>,
    pub product: Option<String>,
    pub version: Option<String>,
    pub project: Option<String>,
    pub timeline: Option<String>,
    pub timelines: Vec<String>,
    /// Why the state last changed (the watcher's `reason`), so the app knows when to re-sync.
    pub reason: Option<String>,
    /// Epoch seconds of the last change.
    pub changed_at: f64,
}

impl NleState {
    fn plain(host: Host, status: NleStatus, message: Option<String>, now: f64) -> Self {
        NleState {
            host,
            status,
            message,
            product: None,
            version: None,
            project: None,
            timeline: None,
            timelines: Vec::new(),
            reason: None,
            changed_at: now,
        }
    }

    /// The state a watcher's `state` event describes.
    pub fn from_event(host: Host, event: &Value, now: f64) -> Self {
        let text = |key: &str| event.get(key).and_then(Value::as_str).map(String::from);
        let status = match event.get("status").and_then(Value::as_str) {
            Some("connected") => NleStatus::Connected,
            _ => NleStatus::Disconnected,
        };
        NleState {
            host,
            status,
            message: text("message"),
            product: text("product"),
            version: text("version"),
            project: text("project"),
            timeline: text("timeline"),
            timelines: event
                .get("timelines")
                .and_then(Value::as_array)
                .map(|names| names.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default(),
            reason: text("reason"),
            changed_at: now,
        }
    }
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// 1 s, 2 s, 4 s... capped at `MAX_BACKOFF`, before restart number `attempt` (1-based).
pub fn backoff(attempt: u32) -> Duration {
    let seconds = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(u64::MAX);
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

/// A call's `reply` event as (id, result).
pub fn parse_reply(event: &Value) -> Option<(String, Result<Value, String>)> {
    if event.get("type").and_then(Value::as_str) != Some("reply") {
        return None;
    }
    let id = event.get("id").and_then(Value::as_str)?.to_string();
    let result = if event.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(event.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(event.get("error").and_then(Value::as_str).unwrap_or("The editor couldn't do that").to_string())
    };
    Some((id, result))
}

type Reply = Result<Value, String>;

/// Calls waiting for their reply.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<String, Sender<Reply>>>,
}

impl Pending {
    pub fn register(&self) -> (String, mpsc::Receiver<Reply>) {
        let id = format!("c{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = mpsc::channel();
        lock(&self.waiting).insert(id.clone(), sender);
        (id, receiver)
    }

    pub fn resolve(&self, id: &str, reply: Reply) {
        if let Some(sender) = lock(&self.waiting).remove(id) {
            let _ = sender.send(reply);
        }
    }

    pub fn forget(&self, id: &str) {
        lock(&self.waiting).remove(id);
    }

    /// Answers every waiting call with `message`: the watcher they were sent to is gone.
    pub fn fail_all(&self, message: &str) {
        for (_, sender) in lock(&self.waiting).drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

/// One editor's watcher: its last state, its calls in flight, and which start is current (so a
/// watcher still winding down after a reconnect can't overwrite its successor's state).
struct Slot {
    state: Mutex<NleState>,
    generation: AtomicU64,
    pending: Pending,
}

impl Slot {
    fn new(host: Host) -> Self {
        Slot {
            state: Mutex::new(NleState::plain(host, NleStatus::Connecting, None, now())),
            generation: AtomicU64::new(0),
            pending: Pending::default(),
        }
    }
}

pub struct Nle {
    premiere: Slot,
    resolve: Slot,
}

impl Default for Nle {
    fn default() -> Self {
        Nle { premiere: Slot::new(Host::Premiere), resolve: Slot::new(Host::Resolve) }
    }
}

impl Nle {
    fn slot(&self, host: Host) -> &Slot {
        match host {
            Host::Premiere => &self.premiere,
            Host::Resolve => &self.resolve,
        }
    }

    pub fn states(&self) -> Vec<NleState> {
        Host::ALL.iter().map(|host| lock(&self.slot(*host).state).clone()).collect()
    }
}

fn publish(app: &AppHandle, host: Host, generation: u64, state: NleState) {
    let nle = app.state::<Nle>();
    let slot = nle.slot(host);
    if slot.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    *lock(&slot.state) = state.clone();
    let _ = app.emit(STATE_EVENT, state);
}

/// The process that watches `host`, or why there can't be one.
fn launch_for(app: &AppHandle, host: Host) -> Result<Launch, (NleStatus, String)> {
    let root = python_root(app);
    if !package_dir(&root).join("__main__.py").is_file() {
        return Err((NleStatus::Error, format!("The agent sidecar is not installed at {}", package_dir(&root).display())));
    }
    Ok(match host {
        Host::Premiere => Launch::for_command(&root, uv_environment(app).as_deref(), host.command(), &[]),
        Host::Resolve => {
            if !resolve_python().is_file() {
                return Err((NleStatus::Unavailable, "DaVinci Resolve 21.1 or later isn't installed.".into()));
            }
            Launch::for_resolve(&root)
        }
    })
}

/// (Re)starts the watcher for `host`. `attempt` counts restarts in a row that never reached `ready`.
pub fn start_watcher(app: &AppHandle, host: Host, attempt: u32) {
    let nle = app.state::<Nle>();
    let jobs = app.state::<SidecarJobs>();
    let slot = nle.slot(host);
    let generation = slot.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(previous) = jobs.get(host.job_id()) {
        jobs.remove_if_same(host.job_id(), &previous);
        previous.cancel();
    }
    slot.pending.fail_all(&format!("The connection to {} restarted", host.label()));

    let launch = match launch_for(app, host) {
        Ok(launch) => launch,
        Err((status, message)) => {
            publish(app, host, generation, NleState::plain(host, status, Some(message), now()));
            return;
        }
    };
    let message = (attempt > 0).then(|| format!("Restarting the {} watcher…", host.label()));
    publish(app, host, generation, NleState::plain(host, NleStatus::Connecting, message, now()));

    let job = Arc::new(SidecarJob::default());
    if let Err(message) = jobs.insert(host.job_id(), &job) {
        publish(app, host, generation, NleState::plain(host, NleStatus::Error, Some(message), now()));
        return;
    }
    let child = match start_child(&launch, &job) {
        Ok(child) => child,
        Err(message) => {
            jobs.remove_if_same(host.job_id(), &job);
            publish(app, host, generation, NleState::plain(host, NleStatus::Error, Some(message), now()));
            return;
        }
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let nle = app.state::<Nle>();
        let slot = nle.slot(host);
        let mut saw_ready = false;
        let mut last_error: Option<String> = None;
        let exit = pump(host.job_id(), &job, child, &json!({}), true, |event| match event.get("type").and_then(Value::as_str) {
            Some("ready") => saw_ready = true,
            Some("state") => publish(&app, host, generation, NleState::from_event(host, &event, now())),
            Some("reply") => {
                if let Some((id, reply)) = parse_reply(&event) {
                    slot.pending.resolve(&id, reply);
                }
            }
            Some("error") => last_error = event.get("message").and_then(Value::as_str).map(String::from),
            _ => {}
        });
        app.state::<SidecarJobs>().remove_if_same(host.job_id(), &job);
        slot.pending.fail_all(&format!("The {} watcher stopped", host.label()));

        // Cancelled means replaced by a newer start, or the app is quitting.
        if exit.cancelled || slot.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let why = exit.message.or(last_error).unwrap_or_else(|| format!("exit code {:?}", exit.code));
        let attempt = if saw_ready { 1 } else { attempt + 1 };
        if attempt > GIVE_UP_AFTER {
            let message = format!("The {} watcher keeps failing: {why}. Press Reconnect to try again.", host.label());
            publish(&app, host, generation, NleState::plain(host, NleStatus::Error, Some(message), now()));
            return;
        }
        let message = format!("The {} watcher stopped ({why}); restarting…", host.label());
        publish(&app, host, generation, NleState::plain(host, NleStatus::Error, Some(message), now()));
        std::thread::sleep(backoff(attempt));
        if slot.generation.load(Ordering::SeqCst) == generation {
            start_watcher(&app, host, attempt);
        }
    });
}

pub fn start_all(app: &AppHandle) {
    for host in Host::ALL {
        start_watcher(app, host, 0);
    }
}

// ------------------------------------------------------------------------------------ commands

#[tauri::command]
pub fn nle_state(nle: State<'_, Nle>) -> Vec<NleState> {
    nle.states()
}

/// Restarts the watcher for `host` now, clearing any backoff or give-up.
#[tauri::command]
pub async fn nle_reconnect(app: AppHandle, host: Host) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_watcher(&app, host, 0)).await.map_err(|e| e.to_string())
}

/// Sends one call to `host`'s watcher and returns its result. The watcher allows only its adapter's
/// `calls` (watch.py) and checks the arguments.
#[tauri::command]
pub async fn nle_call(app: AppHandle, host: Host, command: String, args: Value) -> Result<Value, String> {
    if !args.is_object() {
        return Err("args must be an object".into());
    }
    let job = app
        .state::<SidecarJobs>()
        .get(host.job_id())
        .ok_or_else(|| format!("{} isn't being watched right now", host.label()))?;
    let (id, receiver) = app.state::<Nle>().slot(host).pending.register();
    let message = json!({ "type": "call", "id": id, "command": command, "args": args });
    match job.send_line(&message) {
        Ok(true) => {}
        Ok(false) => {
            app.state::<Nle>().slot(host).pending.forget(&id);
            return Err(format!("{} isn't being watched right now", host.label()));
        }
        Err(error) => {
            app.state::<Nle>().slot(host).pending.forget(&id);
            return Err(error);
        }
    }
    let timeout = call_timeout(&command);
    let waited = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(timeout))
        .await
        .map_err(|e| e.to_string())?;
    match waited {
        Ok(reply) => reply,
        Err(RecvTimeoutError::Timeout) => {
            app.state::<Nle>().slot(host).pending.forget(&id);
            Err(format!("{} didn't answer within {} s", host.label(), timeout.as_secs()))
        }
        Err(RecvTimeoutError::Disconnected) => Err(format!("The {} watcher stopped", host.label())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_serialize_lowercase_and_map_to_watch_commands() {
        assert_eq!(serde_json::to_string(&Host::Resolve).unwrap(), "\"resolve\"");
        assert_eq!(serde_json::from_str::<Host>("\"premiere\"").unwrap(), Host::Premiere);
        for host in Host::ALL {
            let spec = crate::sidecar::find_command(host.command()).unwrap();
            assert!(spec.managed && spec.interactive);
        }
    }

    #[test]
    fn state_events_become_frontend_state() {
        let event = json!({
            "type": "state", "host": "premiere", "status": "connected", "message": null,
            "product": "Adobe Premiere Pro", "version": "26.5.2", "project": "Doc",
            "timeline": "Main", "timelines": ["Main", "B", 3], "instance": "x", "reason": "restarted"
        });
        let state = NleState::from_event(Host::Premiere, &event, 10.0);
        assert_eq!(state.status, NleStatus::Connected);
        assert_eq!(state.project.as_deref(), Some("Doc"));
        assert_eq!(state.timelines, vec!["Main", "B"]);
        assert_eq!(state.reason.as_deref(), Some("restarted"));
        assert_eq!(state.changed_at, 10.0);

        let gone = json!({"type": "state", "status": "disconnected", "message": "Premiere Pro isn't running.", "reason": "disconnected"});
        let state = NleState::from_event(Host::Premiere, &gone, 11.0);
        assert_eq!(state.status, NleStatus::Disconnected);
        assert_eq!(state.message.as_deref(), Some("Premiere Pro isn't running."));
        assert!(state.timelines.is_empty());

        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(wire["status"], "disconnected");
        assert_eq!(wire["changedAt"], 11.0);
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let secs: Vec<u64> = (1..=8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(200), MAX_BACKOFF);
    }

    #[test]
    fn replies_carry_results_or_errors() {
        assert_eq!(parse_reply(&json!({"type": "reply", "id": "c1", "ok": true, "result": {"a": 1}})), Some(("c1".into(), Ok(json!({"a": 1})))));
        assert_eq!(parse_reply(&json!({"type": "reply", "id": "c2", "ok": false, "error": "No project"})), Some(("c2".into(), Err("No project".into()))));
        assert_eq!(parse_reply(&json!({"type": "state"})), None);
        assert_eq!(parse_reply(&json!({"type": "reply", "ok": true})), None);
    }

    #[test]
    fn pending_calls_are_answered_once_or_failed_together() {
        let pending = Pending::default();
        let (a, ra) = pending.register();
        let (b, rb) = pending.register();
        assert_ne!(a, b);
        pending.resolve(&a, Ok(json!(1)));
        pending.resolve(&a, Ok(json!(2))); // already answered: ignored
        assert_eq!(ra.recv().unwrap(), Ok(json!(1)));
        pending.fail_all("watcher stopped");
        assert_eq!(rb.recv().unwrap(), Err("watcher stopped".into()));
        let (c, rc) = pending.register();
        pending.forget(&c);
        assert!(rc.recv_timeout(Duration::from_millis(10)).is_err());
        assert_eq!(call_timeout("rebuild"), Duration::from_secs(200));
        assert_eq!(call_timeout("read_timeline"), Duration::from_secs(35));
    }
}
