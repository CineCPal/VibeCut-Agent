//! The MCP bridge (PLAN.md, "Phase 7a"): lets an MCP client call the agent's own tools. The client is
//! the app's own Claude Code run (7b) or an interactive Claude Code session the user started (7d). The
//! client launches `python -m vibecut_agent mcp` (vibecut_agent/mcp_server.py), which talks to the app
//! through files, as the B-roll panel does (broll_panel.rs); there is no network port.
//!
//! `~/Library/Application Support/VibeCut Agent/host-bridge/mcp/` (mode 0700) holds:
//! - `requests/<id>.json`: one request from the shim, renamed into place. Read here, checked, deleted
//!   and handed to the frontend as an `mcp-request` event (src/lib/mcp/server.ts).
//! - `replies/<id>.json`: the answer, written by the frontend through `mcp_reply`; the shim deletes it.
//! - `agent-alive.json`: stamped here every second with whether outside control is allowed, so the
//!   shim can tell "the app isn't running" from "outside control is off".
//!
//! A request's `caller` is either a running chat job (the app's own Claude Code run, always served) or
//! `"outside"`, served only while Settings → Outside control → Allow is on (off by default, saved as
//! `mcp.json` in the app's config folder). Refused requests are answered here and never reach the UI.

use crate::broll_panel::write_atomic;
use crate::sidecar::{build_args, python_root, uv_binary, uv_environment, SidecarJobs};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub const REQUEST_EVENT: &str = "mcp-request";
pub const OUTSIDE_EVENT: &str = "mcp-outside";
pub const OUTSIDE: &str = "outside";
const POLL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(1);
const MAX_REQUEST_BYTES: u64 = 256 * 1024;
const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 64;
const SETTINGS_FILE: &str = "mcp.json";

static STARTED: AtomicBool = AtomicBool::new(false);
static OUTSIDE_ALLOWED: AtomicBool = AtomicBool::new(false);
/// When the last outside request arrived (ms since the epoch; 0: never this run).
static LAST_OUTSIDE_MS: AtomicU64 = AtomicU64::new(0);

/// The bridge folder. `VIBECUT_AGENT_MCP_DIR` overrides it (tests and parallel dev builds).
pub fn bridge_dir() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_MCP_DIR") {
        return Ok(PathBuf::from(custom));
    }
    let home = std::env::var_os("HOME").ok_or("HOME isn't set")?;
    Ok(Path::new(&home).join("Library/Application Support/VibeCut Agent/host-bridge/mcp"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_tool_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME_CHARS && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Rebuilds a request from the fields its kind allows.
pub fn validate_request(value: &Value, file_id: &str) -> Result<Value, String> {
    let Value::Object(request) = value else {
        return Err("a request must be an object".into());
    };
    if request.get("id").and_then(Value::as_str) != Some(file_id) {
        return Err("the request's id must match its file name".into());
    }
    let caller = request.get("caller").and_then(Value::as_str).filter(|c| valid_id(c)).ok_or("caller must be an id")?;
    let kind = request.get("kind").and_then(Value::as_str).ok_or("kind must be a string")?;
    let mut out = Map::new();
    out.insert("id".into(), Value::String(file_id.into()));
    out.insert("caller".into(), Value::String(caller.into()));
    out.insert("kind".into(), Value::String(kind.into()));
    match kind {
        "list_tools" => {}
        "call_tool" => {
            let name = request.get("name").and_then(Value::as_str).filter(|n| valid_tool_name(n)).ok_or("name must be a tool name")?;
            let args = match request.get("args") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(Value::Object(args)) => Value::Object(args.clone()),
                Some(_) => return Err("args must be an object".into()),
            };
            out.insert("name".into(), Value::String(name.into()));
            out.insert("args".into(), args);
        }
        other => return Err(format!("unknown request kind {other:?}")),
    }
    Ok(Value::Object(out))
}

fn read_request(path: &Path, file_id: &str) -> Result<Value, String> {
    if !valid_id(file_id) {
        return Err("the request's file name isn't an id".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("the request isn't a plain file".into());
    }
    if meta.len() > MAX_REQUEST_BYTES {
        return Err("the request is too large".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("couldn't read the request: {e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("the request isn't JSON: {e}"))?;
    validate_request(&value, file_id)
}

/// One request taken from `requests/`: checked, or why it was refused (`file_id` empty when even the
/// file name was bad, so nobody can be answered).
#[derive(Debug, PartialEq)]
pub struct Drained {
    pub file_id: String,
    pub request: Result<Value, String>,
}

/// Reads, checks and deletes every request waiting, oldest first. Hidden (half-written) files stay.
pub fn drain_requests(dir: &Path) -> Vec<Drained> {
    let Ok(entries) = std::fs::read_dir(dir.join("requests")) else {
        return Vec::new();
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter(|p| p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.')))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), p))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|(_, path)| {
            let file_id = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let request = read_request(&path, &file_id);
            let _ = std::fs::remove_file(&path);
            Drained { file_id: if valid_id(&file_id) { file_id } else { String::new() }, request }
        })
        .collect()
}

/// Why a checked request mustn't reach the frontend, if it mustn't: an outside caller while outside
/// control is off, or a chat job that isn't running.
pub fn refusal(request: &Value, outside_allowed: bool, job_running: impl Fn(&str) -> bool) -> Option<String> {
    let caller = request.get("caller").and_then(Value::as_str).unwrap_or_default();
    if caller == OUTSIDE {
        return (!outside_allowed).then(|| {
            "Outside control is off in VibeCut Agent. Turn it on in Settings → Outside control, then try again.".to_string()
        });
    }
    (!job_running(caller)).then(|| "That VibeCut Agent chat has ended.".to_string())
}

fn write_reply(dir: &Path, id: &str, reply: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(reply).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPLY_BYTES {
        let message = format!("The tool's result is too large to return ({} MB).", bytes.len() / (1024 * 1024));
        let small = serde_json::json!({ "id": id, "ok": false, "error": message });
        return write_atomic(&dir.join("replies"), &format!("{id}.json"), small.to_string().as_bytes());
    }
    write_atomic(&dir.join("replies"), &format!("{id}.json"), &bytes)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Makes the folder and its two subfolders, readable by this user only.
pub fn prepare_dir(dir: &Path) -> Result<(), String> {
    for sub in ["requests", "replies"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| format!("Couldn't make the MCP folder: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [dir.to_path_buf(), dir.join("requests"), dir.join("replies")] {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

/// Replies older than this were never collected (the shim gave up or died) and are cleared away.
const STALE_REPLY: Duration = Duration::from_secs(30 * 60);

fn prune_replies(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir.join("replies")) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_REPLY);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn serve(app: AppHandle, dir: PathBuf) {
    let mut last_beat: Option<std::time::Instant> = None;
    let mut last_prune: Option<std::time::Instant> = None;
    loop {
        if last_beat.is_none_or(|t| t.elapsed() >= HEARTBEAT) {
            // The folder can be deleted under a running app; make it again.
            if prepare_dir(&dir).is_ok() {
                let stamp = serde_json::json!({
                    "at": now_ms(),
                    "pid": std::process::id(),
                    "outsideAllowed": OUTSIDE_ALLOWED.load(Ordering::SeqCst),
                });
                let _ = write_atomic(&dir, "agent-alive.json", stamp.to_string().as_bytes());
            }
            last_beat = Some(std::time::Instant::now());
        }
        if last_prune.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
            prune_replies(&dir);
            last_prune = Some(std::time::Instant::now());
        }
        for drained in drain_requests(&dir) {
            let request = match drained.request {
                Ok(request) => request,
                Err(error) => {
                    if !drained.file_id.is_empty() {
                        let reply = serde_json::json!({ "id": drained.file_id, "ok": false, "error": error });
                        let _ = write_reply(&dir, &drained.file_id, &reply);
                    }
                    continue;
                }
            };
            let jobs = app.state::<SidecarJobs>();
            let allowed = OUTSIDE_ALLOWED.load(Ordering::SeqCst);
            if let Some(error) = refusal(&request, allowed, |job| jobs.get(job).is_some()) {
                let reply = serde_json::json!({ "id": drained.file_id, "ok": false, "error": error });
                let _ = write_reply(&dir, &drained.file_id, &reply);
                continue;
            }
            if request.get("caller").and_then(Value::as_str) == Some(OUTSIDE) {
                LAST_OUTSIDE_MS.store(now_ms(), Ordering::SeqCst);
            }
            let _ = app.emit(REQUEST_EVENT, request);
        }
        std::thread::sleep(POLL);
    }
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

/// The saved choice from `mcp.json`'s text; off unless it says on.
pub fn parse_outside_allowed(text: Option<&str>) -> bool {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("outsideAllowed").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Loads the saved choice and starts serving the folder (once per app run).
pub fn start(app: &AppHandle) {
    let text = settings_file(app).and_then(|f| std::fs::read_to_string(f).ok());
    OUTSIDE_ALLOWED.store(parse_outside_allowed(text.as_deref()), Ordering::SeqCst);
    let Ok(dir) = bridge_dir() else { return };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("mcp-bridge".into()).spawn(move || serve(app, dir));
}

/// Writes the frontend's answer to a request.
#[tauri::command]
pub fn mcp_reply(id: String, reply: Value) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Not a request id".into());
    }
    let Value::Object(mut reply) = reply else {
        return Err("The reply must be an object".into());
    };
    reply.insert("id".into(), Value::String(id.clone()));
    write_reply(&bridge_dir()?, &id, &Value::Object(reply))
}

/// How an MCP client starts the shim: `uv run` in the sidecar's locked environment with the `mcp` extra,
/// and the environment variables it needs (the package on PYTHONPATH, the release venv, a custom
/// bridge folder). The client adds its own environment around these.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShimLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn shim_launch(uv: &Path, root: &Path, environment: Option<&Path>, bridge_override: Option<&Path>) -> ShimLaunch {
    let mut env = vec![
        ("PYTHONPATH".to_string(), root.join("src-python").to_string_lossy().into_owned()),
        ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
    ];
    if let Some(environment) = environment {
        env.push(("UV_PROJECT_ENVIRONMENT".into(), environment.to_string_lossy().into_owned()));
    }
    if let Some(folder) = bridge_override {
        env.push(("VIBECUT_AGENT_MCP_DIR".into(), folder.to_string_lossy().into_owned()));
    }
    ShimLaunch { program: uv.to_string_lossy().into_owned(), args: build_args(root, "mcp", &["mcp"]), env }
}

/// One word for a POSIX shell: left bare when it's plainly safe, else single-quoted.
pub fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// The `claude mcp add` line that registers the shim with Claude Code (user scope, so every folder's
/// sessions have it).
pub fn claude_add_command(launch: &ShimLaunch) -> String {
    let mut words = vec!["claude".to_string(), "mcp".into(), "add".into(), "--scope".into(), "user".into()];
    for (key, value) in &launch.env {
        words.push("-e".into());
        words.push(shell_quote(&format!("{key}={value}")));
    }
    words.push(SERVER_NAME.into());
    words.push("--".into());
    words.push(shell_quote(&launch.program));
    words.extend(launch.args.iter().map(|a| shell_quote(a)));
    words.join(" ")
}

pub const SERVER_NAME: &str = "vibecut";

/// The `claude` line that starts a locked-down Remote Control session for editing (Phase 7f): no
/// built-in tools (shell, files, web), no MCP server but VibeCut's (given inline, so it needs no
/// `claude mcp add`), and VibeCut's tools allowed without asking. The user's own Claude Code
/// sessions keep their full tools; this one can only edit through VibeCut.
pub fn remote_command(launch: &ShimLaunch) -> String {
    let env: serde_json::Map<String, Value> = launch.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    let config = serde_json::json!({ "mcpServers": { SERVER_NAME: { "command": launch.program, "args": launch.args, "env": env } } });
    [
        "claude".to_string(),
        "--remote-control".into(),
        "vibecut".into(),
        "--tools".into(),
        shell_quote(""),
        "--strict-mcp-config".into(),
        "--mcp-config".into(),
        shell_quote(&config.to_string()),
        "--allowedTools".into(),
        shell_quote(&format!("mcp__{SERVER_NAME}__*")),
    ]
    .join(" ")
}

pub fn app_shim_launch(app: &AppHandle) -> ShimLaunch {
    let bridge_override = std::env::var_os("VIBECUT_AGENT_MCP_DIR").map(PathBuf::from);
    shim_launch(&uv_binary(), &python_root(app), uv_environment(app).as_deref(), bridge_override.as_deref())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSetup {
    pub launch: ShimLaunch,
    /// Ready to paste into Terminal: adds VibeCut to every Claude Code session (with its usual tools).
    pub claude_add: String,
    /// Ready to paste into Terminal: a Remote Control session that can only edit through VibeCut.
    pub remote_start: String,
}

/// What Settings → Outside control offers to copy.
#[tauri::command]
pub fn mcp_client_setup(app: AppHandle) -> ClientSetup {
    let launch = app_shim_launch(&app);
    ClientSetup { claude_add: claude_add_command(&launch), remote_start: remote_command(&launch), launch }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub outside_allowed: bool,
    /// When the last outside request arrived this run (ms since the epoch), if one did.
    pub last_outside_at: Option<u64>,
    pub folder: String,
}

fn status() -> McpStatus {
    let last = LAST_OUTSIDE_MS.load(Ordering::SeqCst);
    McpStatus {
        outside_allowed: OUTSIDE_ALLOWED.load(Ordering::SeqCst),
        last_outside_at: (last > 0).then_some(last),
        folder: bridge_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn mcp_status() -> McpStatus {
    status()
}

/// Saves and applies Allow; the next heartbeat tells the shim. Announced as `mcp-outside`.
#[tauri::command]
pub fn mcp_set_outside_allowed(app: AppHandle, on: bool) -> Result<McpStatus, String> {
    let path = settings_file(&app).ok_or("The app's config folder is unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::json!({ "outsideAllowed": on }).to_string()).map_err(|e| e.to_string())?;
    OUTSIDE_ALLOWED.store(on, Ordering::SeqCst);
    let now = status();
    let _ = app.emit(OUTSIDE_EVENT, now.clone());
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        prepare_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn requests_are_rebuilt_from_the_fields_their_kind_allows() {
        let call = json!({"id": "r1", "caller": "outside", "kind": "call_tool", "name": "add_markers", "args": {"markers": []}, "extra": 1});
        assert_eq!(
            validate_request(&call, "r1").unwrap(),
            json!({"id": "r1", "caller": "outside", "kind": "call_tool", "name": "add_markers", "args": {"markers": []}})
        );
        let list = json!({"id": "r2", "caller": "job-1", "kind": "list_tools", "name": "x"});
        assert_eq!(validate_request(&list, "r2").unwrap(), json!({"id": "r2", "caller": "job-1", "kind": "list_tools"}));
        let no_args = json!({"id": "r3", "caller": "outside", "kind": "call_tool", "name": "list_markers"});
        assert_eq!(validate_request(&no_args, "r3").unwrap()["args"], json!({}));
        assert!(validate_request(&json!({"id": "r4", "caller": "outside", "kind": "call_tool", "name": "../x"}), "r4").is_err());
        assert!(validate_request(&json!({"id": "r5", "caller": "outside", "kind": "call_tool", "name": "a", "args": [1]}), "r5").is_err());
        assert!(validate_request(&json!({"id": "r6", "caller": "a b", "kind": "list_tools"}), "r6").is_err());
        assert!(validate_request(&json!({"id": "r7", "caller": "outside", "kind": "run_shell"}), "r7").is_err());
        assert!(validate_request(&json!({"id": "r8", "caller": "outside", "kind": "list_tools"}), "other").is_err());
    }

    #[test]
    fn requests_are_drained_oldest_first_and_bad_files_are_refused() {
        let dir = temp_dir("drain");
        std::fs::write(dir.join("requests/a1.json"), r#"{"id":"a1","caller":"outside","kind":"list_tools"}"#).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("requests/a2.json"), "not json").unwrap();
        std::fs::write(dir.join("requests/.a3.json.tmp"), "{}").unwrap();
        let drained = drain_requests(&dir);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].request, Ok(json!({"id": "a1", "caller": "outside", "kind": "list_tools"})));
        assert_eq!(drained[1].file_id, "a2");
        assert!(drained[1].request.as_ref().unwrap_err().contains("isn't JSON"));
        let left: Vec<_> = std::fs::read_dir(dir.join("requests")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "the hidden half-written file stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outside_callers_need_allow_and_chat_callers_a_running_job() {
        let outside = json!({"caller": "outside"});
        assert!(refusal(&outside, false, |_| true).unwrap().contains("Outside control is off"));
        assert_eq!(refusal(&outside, true, |_| false), None);
        let chat = json!({"caller": "job-7"});
        assert_eq!(refusal(&chat, false, |job| job == "job-7"), None);
        assert!(refusal(&chat, true, |_| false).unwrap().contains("has ended"));
    }

    #[test]
    fn replies_are_written_whole_and_oversized_ones_become_an_error() {
        let dir = temp_dir("reply");
        write_reply(&dir, "r1", &json!({"id": "r1", "ok": true, "result": {"n": 1}})).unwrap();
        let text = std::fs::read_to_string(dir.join("replies/r1.json")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["result"], json!({"n": 1}));
        let big = "x".repeat(MAX_REPLY_BYTES + 1);
        write_reply(&dir, "r2", &json!({"id": "r2", "ok": true, "result": big})).unwrap();
        let text = std::fs::read_to_string(dir.join("replies/r2.json")).unwrap();
        let reply: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reply["ok"], json!(false));
        assert!(reply["error"].as_str().unwrap().contains("too large"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outside_control_is_off_unless_saved_on() {
        assert!(!parse_outside_allowed(None));
        assert!(!parse_outside_allowed(Some("not json")));
        assert!(!parse_outside_allowed(Some(r#"{"outsideAllowed": false}"#)));
        assert!(parse_outside_allowed(Some(r#"{"outsideAllowed": true}"#)));
    }


    #[test]
    fn the_claude_code_command_runs_the_shim_in_the_locked_environment() {
        let launch = shim_launch(
            Path::new("/opt/homebrew/bin/uv"),
            Path::new("/Applications/VibeCut Agent.app/Contents/Resources/python"),
            Some(Path::new("/Users/me/Library/Application Support/com.cj.vibecutagent/python-env")),
            None,
        );
        assert!(launch.args.windows(2).any(|w| w == ["--extra", "mcp"]));
        assert_eq!(launch.args.last().map(String::as_str), Some("mcp"));
        assert!(launch.args.contains(&"--locked".to_string()));
        assert_eq!(launch.env[0].0, "PYTHONPATH");
        assert_eq!(launch.env[2].0, "UV_PROJECT_ENVIRONMENT");
        let line = claude_add_command(&launch);
        assert!(line.starts_with("claude mcp add --scope user -e "));
        assert!(line.contains(" vibecut -- /opt/homebrew/bin/uv run --locked"));
        assert!(line.contains("'/Applications/VibeCut Agent.app/Contents/Resources/python'"));
        assert!(line.contains("'UV_PROJECT_ENVIRONMENT=/Users/me/Library/Application Support/com.cj.vibecutagent/python-env'"));
    }

    #[test]
    fn the_remote_session_is_locked_to_vibecuts_tools() {
        let launch = shim_launch(Path::new("/opt/homebrew/bin/uv"), Path::new("/r/my app"), None, None);
        let line = remote_command(&launch);
        assert!(line.starts_with("claude --remote-control vibecut --tools '' --strict-mcp-config --mcp-config '{"));
        assert!(line.ends_with(" --allowedTools 'mcp__vibecut__*'"));
        let json = line.split("--mcp-config '").nth(1).unwrap().split("' --allowedTools").next().unwrap();
        let config: Value = serde_json::from_str(json).unwrap();
        let server = &config["mcpServers"]["vibecut"];
        assert_eq!(server["command"], "/opt/homebrew/bin/uv");
        assert_eq!(server["args"].as_array().unwrap().last().unwrap(), "mcp");
        assert_eq!(server["env"]["PYTHONPATH"], "/r/my app/src-python");
        assert!(server["env"].get("VIBECUT_MCP_CALLER").is_none(), "an outside caller");
    }

    #[test]
    fn shell_words_are_quoted_only_when_needed() {
        assert_eq!(shell_quote("/usr/bin/uv"), "/usr/bin/uv");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_is_private_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        for path in [dir.clone(), dir.join("requests"), dir.join("replies")] {
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
