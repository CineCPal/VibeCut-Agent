//! "Claude (subscription)" (PLAN.md, "Phase 7b"): the chat agent run by the user's own signed-in
//! Claude Code CLI, so a turn uses their Claude subscription and needs no API key. Personal use only:
//! the login belongs to whoever signed in on this Mac.
//!
//! The chat sidecar starts `claude -p` for each turn (vibecut_agent/agent/claude_code_chat.py) with
//! Claude Code's own tools turned off and only VibeCut's MCP server (the Phase 7a shim) allowed; the
//! tool calls come back to the app through the MCP bridge (mcp_bridge.rs), tagged with the chat job.
//!
//! What the sidecar may run is decided here, never by the webview: the program (a path chosen in
//! Settings, else the usual install places) and the Claude Code profile folder (`CLAUDE_CONFIG_DIR`;
//! this Mac's `claude` is a shell function that picks one, and the sidecar never runs the user's shell).
//! Both are saved as `claude-code.json` in the app's config folder and injected into a `chat` request
//! as `claudeCode` by `sidecar::prepare_request`; anything the UI sent under that name is dropped.

use crate::mcp_bridge::{app_shim_launch, ShimLaunch};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "claude-code.json";
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// `/usage` is answered locally (no model call; 0.7 s on 2.1.292), but it asks the account server.
const USAGE_TIMEOUT: Duration = Duration::from_secs(20);
pub const PROVIDER: &str = "claude-code";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Saved {
    pub program: Option<PathBuf>,
    pub config_dir: Option<PathBuf>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

pub fn parse_saved(text: Option<&str>) -> Saved {
    let value = text.and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    let path = |key: &str| value.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    Saved { program: path("program"), config_dir: path("configDir") }
}

pub fn saved(app: &AppHandle) -> Saved {
    parse_saved(settings_file(app).and_then(|f| std::fs::read_to_string(f).ok()).as_deref())
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Where Claude Code's installer and Homebrew put `claude`, then PATH.
pub fn candidates(home: Option<&Path>, path_var: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home {
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".claude/local/claude"));
    }
    out.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    if let Some(path_var) = path_var {
        out.extend(std::env::split_paths(path_var).map(|dir| dir.join("claude")));
    }
    out
}

/// The program to run: the saved one if it's there, else the first candidate that is.
pub fn find_program(saved: &Saved, home: Option<&Path>, path_var: Option<&str>) -> Option<PathBuf> {
    if let Some(program) = &saved.program {
        return is_executable(program).then(|| program.clone());
    }
    candidates(home, path_var).into_iter().find(|p| is_executable(p))
}

fn program_for(app: &AppHandle) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    find_program(&saved(app), home.as_deref(), std::env::var("PATH").ok().as_deref())
}

/// Where each turn runs: an empty folder of the app's, so no project's CLAUDE.md or settings apply.
fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("claude-code");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make Claude Code's folder: {e}"))?;
    Ok(dir)
}

/// What a `chat` request on this provider gets (`claudeCode`): the program, the profile folder, the
/// job it belongs to (the shim tags its calls with it) and how to start the shim.
pub fn setup(program: &Path, config_dir: Option<&Path>, job_id: &str, work_dir: &Path, shim: &ShimLaunch) -> Value {
    json!({
        "program": program.to_string_lossy(),
        "configDir": config_dir.map(|d| d.to_string_lossy().into_owned()),
        "jobId": job_id,
        "workDir": work_dir.to_string_lossy(),
        "mcp": shim,
    })
}

pub fn setup_for(app: &AppHandle, job_id: &str) -> Result<Value, String> {
    let program = program_for(app).ok_or(
        "Claude Code isn't installed where VibeCut Agent looks. Install it, or choose the claude program in Settings → Claude subscription.",
    )?;
    let saved = saved(app);
    Ok(setup(&program, saved.config_dir.as_deref(), job_id, &work_dir(app)?, &app_shim_launch(app)))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    /// The program that would run, if one was found.
    pub program: Option<String>,
    pub program_saved: Option<String>,
    pub config_dir: Option<String>,
    /// None when it couldn't be checked.
    pub signed_in: Option<bool>,
    pub email: Option<String>,
    pub subscription: Option<String>,
    /// Why it isn't usable, when it isn't.
    pub detail: Option<String>,
}

/// Reads `claude auth status --json`'s output.
pub fn parse_auth(status: &mut ClaudeCodeStatus, stdout: &str) {
    let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) else {
        status.detail = Some("Claude Code's sign-in status couldn't be read.".into());
        return;
    };
    let signed_in = value.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
    let method = value.get("authMethod").and_then(Value::as_str).unwrap_or_default();
    status.signed_in = Some(signed_in);
    status.email = value.get("email").and_then(Value::as_str).map(str::to_string);
    status.subscription = value.get("subscriptionType").and_then(Value::as_str).map(str::to_string);
    if !signed_in {
        status.detail = Some("Claude Code isn't signed in. Run claude in Terminal and sign in with your Claude account.".into());
    } else if method != "claude.ai" {
        status.detail = Some(format!("Claude Code is signed in with {method}, not a Claude subscription; turns may be billed to that account."));
    }
}

/// How the plan's usage is asked for (Phase 9b): Claude Code's own `/usage`, which runs without a model
/// call in print mode. Nothing is saved as a session, and the user's hooks don't run.
pub const USAGE_ARGS: [&str; 7] =
    ["-p", "/usage", "--output-format", "json", "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#];

/// The text of `/usage`'s answer (the `result` of its JSON), or why there's none.
pub fn parse_usage(stdout: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(stdout.trim()).map_err(|_| "Claude Code's usage report couldn't be read.".to_string())?;
    let text = value.get("result").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if value.get("is_error").and_then(Value::as_bool).unwrap_or(false) || text.is_empty() {
        return Err(if text.is_empty() { "Claude Code gave no usage report.".into() } else { text });
    }
    Ok(text)
}

/// Runs Claude Code with a bare environment (no `ANTHROPIC_*`, so it uses the subscription) and the
/// chosen profile, and returns what it printed.
fn run_claude(program: &Path, config_dir: Option<&Path>, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    for name in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(dir) = config_dir {
        command.env("CLAUDE_CONFIG_DIR", dir);
    }
    let mut child = command.spawn().map_err(|e| format!("Couldn't run Claude Code: {e}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Claude Code didn't answer within {} s.", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    Ok(out)
}

fn check(app: &AppHandle) -> ClaudeCodeStatus {
    let saved = saved(app);
    let mut status = ClaudeCodeStatus {
        program_saved: saved.program.as_ref().map(|p| p.to_string_lossy().into_owned()),
        config_dir: saved.config_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        ..Default::default()
    };
    let Some(program) = program_for(app) else {
        status.detail = Some(match &saved.program {
            Some(p) => format!("{} isn't there or can't be run.", p.display()),
            None => "Claude Code isn't installed where VibeCut Agent looks. Install it, or choose the claude program.".into(),
        });
        return status;
    };
    status.program = Some(program.to_string_lossy().into_owned());
    match run_claude(&program, saved.config_dir.as_deref(), &["auth", "status", "--json"], None, AUTH_TIMEOUT) {
        Ok(stdout) => parse_auth(&mut status, &stdout),
        Err(error) => status.detail = Some(error),
    }
    status
}

/// Whether Claude Code is there and signed in (runs `claude auth status`).
#[tauri::command]
pub async fn claude_code_status(app: AppHandle) -> Result<ClaudeCodeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check(&app)).await.map_err(|e| e.to_string())
}

/// The Claude plan's usage as `/usage` reports it (Phase 9b): its text, which the app reads.
#[tauri::command]
pub async fn claude_code_usage(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let program = program_for(&app).ok_or("Claude Code isn't set up. See Settings → Claude subscription.")?;
        let dir = work_dir(&app)?;
        let stdout = run_claude(&program, saved(&app).config_dir.as_deref(), &USAGE_ARGS, Some(&dir), USAGE_TIMEOUT)?;
        parse_usage(&stdout)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the program and the profile folder (empty or null: forget it), then checks again.
#[tauri::command]
pub async fn claude_code_set(app: AppHandle, program: Option<String>, config_dir: Option<String>) -> Result<ClaudeCodeStatus, String> {
    let clean = |value: Option<String>| value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let (program, config_dir) = (clean(program), clean(config_dir));
    if let Some(program) = &program {
        if !is_executable(Path::new(program)) {
            return Err(format!("{program} isn't a program that can be run."));
        }
    }
    if let Some(dir) = &config_dir {
        if !Path::new(dir).is_dir() {
            return Err(format!("{dir} isn't a folder."));
        }
    }
    let path = settings_file(&app).ok_or("The app's config folder is unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json!({ "program": program, "configDir": config_dir }).to_string()).map_err(|e| e.to_string())?;
    claude_code_status(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-claude-code-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn make_program(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn saved_settings_read_back_and_blank_means_none() {
        assert_eq!(parse_saved(None), Saved::default());
        assert_eq!(parse_saved(Some("nope")), Saved::default());
        let saved = parse_saved(Some(r#"{"program": "/x/claude", "configDir": "  "}"#));
        assert_eq!(saved, Saved { program: Some("/x/claude".into()), config_dir: None });
    }

    #[cfg(unix)]
    #[test]
    fn the_program_is_the_saved_one_else_the_first_installed() {
        let home = temp_dir("find");
        make_program(&home.join(".local/bin/claude"));
        assert_eq!(find_program(&Saved::default(), Some(&home), None), Some(home.join(".local/bin/claude")));
        let chosen = home.join("custom/claude");
        make_program(&chosen);
        let saved = Saved { program: Some(chosen.clone()), config_dir: None };
        assert_eq!(find_program(&saved, Some(&home), None), Some(chosen));
        let missing = Saved { program: Some(home.join("gone")), config_dir: None };
        assert_eq!(find_program(&missing, Some(&home), None), None, "a saved program that's gone isn't swapped silently");
        std::fs::write(home.join("plain"), "x").unwrap();
        let not_exec = Saved { program: Some(home.join("plain")), config_dir: None };
        assert_eq!(find_program(&not_exec, Some(&home), None), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_search_covers_the_installer_homebrew_and_path() {
        let found = candidates(Some(Path::new("/Users/me")), Some("/a:/b"));
        assert_eq!(found[0], PathBuf::from("/Users/me/.local/bin/claude"));
        assert!(found.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
        assert_eq!(found.last(), Some(&PathBuf::from("/b/claude")));
    }

    #[test]
    fn the_usage_report_is_its_result_text_and_errors_say_why() {
        let ok = r#"{"type":"result","is_error":false,"result":"Current session: 0% used\nCurrent week (all models): 3% used","local_command":"usage"}"#;
        assert_eq!(parse_usage(ok).unwrap(), "Current session: 0% used\nCurrent week (all models): 3% used");
        assert_eq!(parse_usage(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err(), "Not logged in");
        assert!(parse_usage(r#"{"is_error":false,"result":""}"#).is_err());
        assert!(parse_usage("nope").is_err());
        assert!(USAGE_ARGS.contains(&"--no-session-persistence"));
    }

    #[test]
    fn auth_status_reports_sign_in_and_the_plan() {
        let mut status = ClaudeCodeStatus::default();
        parse_auth(&mut status, r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "subscriptionType": "pro"}"#);
        assert_eq!((status.signed_in, status.email.as_deref(), status.subscription.as_deref(), status.detail), (Some(true), Some("a@b.c"), Some("pro"), None));
        let mut out = ClaudeCodeStatus::default();
        parse_auth(&mut out, r#"{"loggedIn": false}"#);
        assert_eq!(out.signed_in, Some(false));
        assert!(out.detail.unwrap().contains("isn't signed in"));
        let mut key = ClaudeCodeStatus::default();
        parse_auth(&mut key, r#"{"loggedIn": true, "authMethod": "apiKey"}"#);
        assert!(key.detail.unwrap().contains("not a Claude subscription"));
        let mut junk = ClaudeCodeStatus::default();
        parse_auth(&mut junk, "Error: boom");
        assert_eq!(junk.signed_in, None);
    }

    #[test]
    fn a_run_gets_the_program_profile_job_and_shim() {
        let shim = ShimLaunch { program: "/opt/homebrew/bin/uv".into(), args: vec!["run".into()], env: vec![("PYTHONPATH".into(), "/r/src-python".into())] };
        let value = setup(Path::new("/u/.local/bin/claude"), Some(Path::new("/u/.claude-profiles/Personal")), "job-1", Path::new("/data/claude-code"), &shim);
        assert_eq!(value["program"], "/u/.local/bin/claude");
        assert_eq!(value["configDir"], "/u/.claude-profiles/Personal");
        assert_eq!(value["jobId"], "job-1");
        assert_eq!(value["mcp"]["program"], "/opt/homebrew/bin/uv");
        assert_eq!(value["mcp"]["env"][0], json!(["PYTHONPATH", "/r/src-python"]));
        assert_eq!(setup(Path::new("/c"), None, "j", Path::new("/w"), &shim)["configDir"], Value::Null);
    }
}
