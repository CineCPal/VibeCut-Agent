//! "Gemini (subscription)" (PLAN.md, "Phase 17"): the chat agent run by the user's own signed-in
//! Antigravity CLI (`agy`), so a turn uses their Google AI plan and needs no API key. Personal use only:
//! the login belongs to whoever signed in on this Mac.
//!
//! The chat sidecar starts `agy -p` for each turn (vibecut_agent/agent/antigravity_chat.py) on an agent
//! of its own that keeps no built-in tool but `finish`; the tool calls come back to the app through
//! VibeCut's MCP shim and the MCP bridge (mcp_bridge.rs), tagged with the chat job.
//!
//! agy has no per-run MCP config (checked live on 1.2.1), so the shim is registered in the user's own
//! agy config as `vibecut`, by `agy mcp add`, only when the user presses "Add VibeCut's tools" in
//! Settings. It is registered as `/usr/bin/env K=V … <shim>`, so the shim keeps the environment agy
//! passes on (the job's `VIBECUT_MCP_CALLER`) and gets its own paths on top. An agy session the user
//! starts themselves can see it too; its calls carry no job, so the bridge refuses them unless
//! Settings → Outside control allows outside callers.
//!
//! What the sidecar may run is decided here, never by the webview: the program (a path chosen in
//! Settings, else the usual install places) is saved as `antigravity.json` in the app's config folder
//! and injected into a request as `antigravity` by `sidecar::prepare_request`.

use crate::mcp_bridge::{app_shim_launch, ShimLaunch, SERVER_NAME};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "antigravity.json";
/// `agy models` asks Google's server (about 2.4 s signed in, 1.5 s signed out on 1.2.1).
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
const MCP_TIMEOUT: Duration = Duration::from_secs(20);
pub const PROVIDER: &str = "antigravity";
/// How the registered shim is started: `env` keeps agy's environment and adds the shim's variables.
pub const ENV_PROGRAM: &str = "/usr/bin/env";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Saved {
    pub program: Option<PathBuf>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

pub fn parse_saved(text: Option<&str>) -> Saved {
    let value = text.and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    Saved { program: value.get("program").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(PathBuf::from) }
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

/// Where Antigravity's installer and Homebrew put `agy`, then PATH.
pub fn candidates(home: Option<&Path>, path_var: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home {
        out.push(home.join(".local/bin/agy"));
        out.push(home.join(".gemini/bin/agy"));
    }
    out.extend(["/opt/homebrew/bin/agy", "/usr/local/bin/agy"].map(PathBuf::from));
    if let Some(path_var) = path_var {
        out.extend(std::env::split_paths(path_var).map(|dir| dir.join("agy")));
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

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn program_for(app: &AppHandle) -> Option<PathBuf> {
    find_program(&saved(app), home().as_deref(), std::env::var("PATH").ok().as_deref())
}

/// Where each run works: a folder of the app's that holds only the runs' own agent files
/// (`.agents/agents/vibecut-<id>.md`), so no project's rules or agents apply.
fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("antigravity");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make Antigravity's folder: {e}"))?;
    Ok(dir)
}

/// What a request on this provider gets (`antigravity`): the program, the job it belongs to (the shim
/// tags its calls with it) and the working folder.
pub fn setup(program: &Path, job_id: &str, work_dir: &Path) -> Value {
    json!({ "program": program.to_string_lossy(), "jobId": job_id, "workDir": work_dir.to_string_lossy() })
}

/// The `agy mcp add` arguments that register the shim (after the program).
pub fn add_args(launch: &ShimLaunch) -> Vec<String> {
    let mut args = vec!["mcp".to_string(), "add".into(), SERVER_NAME.into(), "--".into()];
    args.extend(registered_command(launch));
    args
}

/// The command and arguments the shim is registered with: `/usr/bin/env K=V … program args…`.
pub fn registered_command(launch: &ShimLaunch) -> Vec<String> {
    let mut words = vec![ENV_PROGRAM.to_string()];
    words.extend(launch.env.iter().map(|(k, v)| format!("{k}={v}")));
    words.push(launch.program.clone());
    words.extend(launch.args.iter().cloned());
    words
}

/// The user's agy MCP config (`~/.gemini/config/mcp_config.json`).
pub fn mcp_config_path(home: &Path) -> PathBuf {
    home.join(".gemini/config/mcp_config.json")
}

/// Whether VibeCut's shim is in agy's MCP config, and whether it's this build's: (added, current).
/// A 0-byte file (agy's own empty config) or no file means it isn't added.
pub fn registration(config: Option<&str>, launch: &ShimLaunch) -> (bool, bool) {
    let value = config.and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    let Some(entry) = value.get("mcpServers").and_then(|s| s.get(SERVER_NAME)) else {
        return (false, false);
    };
    let mut words: Vec<String> = Vec::new();
    if let Some(command) = entry.get("command").and_then(Value::as_str) {
        words.push(command.to_string());
    }
    if let Some(args) = entry.get("args").and_then(Value::as_array) {
        words.extend(args.iter().filter_map(Value::as_str).map(str::to_string));
    }
    let disabled = entry.get("disabled").and_then(Value::as_bool).unwrap_or(false);
    (true, !disabled && words == registered_command(launch))
}

fn registration_for(app: &AppHandle) -> (bool, bool) {
    let config = home().and_then(|h| std::fs::read_to_string(mcp_config_path(&h)).ok());
    registration(config.as_deref(), &app_shim_launch(app))
}

pub fn setup_for(app: &AppHandle, job_id: &str) -> Result<Value, String> {
    let program = program_for(app).ok_or(
        "Antigravity isn't installed where VibeCut Agent looks. Install it, or choose the agy program in Settings → Gemini subscription.",
    )?;
    let (added, current) = registration_for(app);
    if !added {
        return Err("Antigravity doesn't have VibeCut's tools yet. Add them in Settings → Gemini subscription.".into());
    }
    if !current {
        return Err("Antigravity has an older copy of VibeCut's tools. Update them in Settings → Gemini subscription.".into());
    }
    Ok(setup(&program, job_id, &work_dir(app)?))
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityStatus {
    /// The program that would run, if one was found.
    pub program: Option<String>,
    pub program_saved: Option<String>,
    /// None when it couldn't be checked.
    pub signed_in: Option<bool>,
    /// The Gemini families the account offers (`gemini-4-argon`, `gemini-3.8-flash`), without the
    /// effort suffix.
    pub models: Vec<String>,
    /// Whether VibeCut's tools are in agy's MCP config, and whether they're this build's.
    pub tools_added: bool,
    pub tools_current: bool,
    /// Why it isn't usable, when it isn't.
    pub detail: Option<String>,
}

/// The Gemini families in `agy models`' list (`<id>\t<label>` lines).
pub fn parse_models(stdout: &str) -> Vec<String> {
    let mut families: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let id = line.split('\t').next().unwrap_or_default().trim();
        if !id.starts_with("gemini-") {
            continue;
        }
        let family = ["-low", "-medium", "-high"].iter().find_map(|s| id.strip_suffix(s)).unwrap_or(id).to_string();
        if !families.contains(&family) {
            families.push(family);
        }
    }
    families
}

/// Reads what `agy models` did: exit 0 is signed in; "sign in" on stderr is signed out.
pub fn parse_models_run(status: &mut AntigravityStatus, success: bool, stdout: &str, stderr: &str) {
    if success {
        status.signed_in = Some(true);
        status.models = parse_models(stdout);
        if status.models.is_empty() {
            status.detail = Some("Antigravity offers no Gemini model on this account.".into());
        }
    } else if stderr.to_lowercase().contains("sign in") {
        status.signed_in = Some(false);
        status.detail = Some("Antigravity isn't signed in. Run agy in Terminal and sign in with your Google account.".into());
    } else {
        let tail: String = stderr.trim().chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
        status.detail = Some(if tail.is_empty() { "Antigravity's models couldn't be read.".into() } else { tail });
    }
}

/// Runs agy with a bare environment (no Google keys, so it uses the plan) and returns
/// (succeeded, stdout, stderr).
fn run_agy(program: &Path, args: &[String], timeout: Duration) -> Result<(bool, String, String), String> {
    let mut command = Command::new(program);
    command.args(args).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = home() {
        command.current_dir(home);
    }
    for name in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|e| format!("Couldn't run Antigravity: {e}"))?;
    let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
    let out_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let success = loop {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            break exit.success();
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Antigravity didn't answer within {} s.", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ok((success, out_reader.join().unwrap_or_default(), err_reader.join().unwrap_or_default()))
}

fn check(app: &AppHandle) -> AntigravityStatus {
    let saved = saved(app);
    let (tools_added, tools_current) = registration_for(app);
    let mut status = AntigravityStatus {
        program_saved: saved.program.as_ref().map(|p| p.to_string_lossy().into_owned()),
        tools_added,
        tools_current,
        ..Default::default()
    };
    let Some(program) = program_for(app) else {
        status.detail = Some(match &saved.program {
            Some(p) => format!("{} isn't there or can't be run.", p.display()),
            None => "Antigravity isn't installed where VibeCut Agent looks. Install it, or choose the agy program.".into(),
        });
        return status;
    };
    status.program = Some(program.to_string_lossy().into_owned());
    match run_agy(&program, &["models".to_string()], MODELS_TIMEOUT) {
        Ok((success, stdout, stderr)) => parse_models_run(&mut status, success, &stdout, &stderr),
        Err(error) => status.detail = Some(error),
    }
    if status.detail.is_none() && !status.tools_added {
        status.detail = Some("VibeCut's tools aren't added to Antigravity yet.".into());
    } else if status.detail.is_none() && !status.tools_current {
        status.detail = Some("Antigravity has an older copy of VibeCut's tools; update them.".into());
    }
    status
}

/// Whether agy is there and signed in, which Gemini models it offers, and whether it has VibeCut's tools.
#[tauri::command]
pub async fn antigravity_status(app: AppHandle) -> Result<AntigravityStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check(&app)).await.map_err(|e| e.to_string())
}

/// Saves the program (empty or null: forget it), then checks again.
#[tauri::command]
pub async fn antigravity_set(app: AppHandle, program: Option<String>) -> Result<AntigravityStatus, String> {
    let program = program.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(program) = &program {
        if !is_executable(Path::new(program)) {
            return Err(format!("{program} isn't a program that can be run."));
        }
    }
    let path = settings_file(&app).ok_or("The app's config folder is unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json!({ "program": program }).to_string()).map_err(|e| e.to_string())?;
    antigravity_status(app).await
}

fn run_mcp(app: &AppHandle, args: Vec<String>) -> Result<(), String> {
    let program = program_for(app).ok_or("Antigravity isn't set up. Choose the agy program first.")?;
    let (success, stdout, stderr) = run_agy(&program, &args, MCP_TIMEOUT)?;
    if success {
        Ok(())
    } else {
        Err(format!("agy mcp {} didn't work: {}", args[1], (stderr.trim().to_string() + stdout.trim()).chars().take(300).collect::<String>()))
    }
}

/// Adds (or updates) VibeCut's tools in the user's agy config: `agy mcp add vibecut -- /usr/bin/env …`.
/// Only ever run from the user's own click in Settings.
#[tauri::command]
pub async fn antigravity_add_tools(app: AppHandle) -> Result<AntigravityStatus, String> {
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_mcp(&task_app, add_args(&app_shim_launch(&task_app))))
        .await
        .map_err(|e| e.to_string())??;
    antigravity_status(app).await
}

/// Takes VibeCut's tools back out of the user's agy config (`agy mcp remove vibecut`).
#[tauri::command]
pub async fn antigravity_remove_tools(app: AppHandle) -> Result<AntigravityStatus, String> {
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_mcp(&task_app, vec!["mcp".into(), "remove".into(), SERVER_NAME.into()]))
        .await
        .map_err(|e| e.to_string())??;
    antigravity_status(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shim() -> ShimLaunch {
        ShimLaunch {
            program: "/opt/homebrew/bin/uv".into(),
            args: vec!["run".into(), "--project".into(), "/r".into(), "python".into()],
            env: vec![("PYTHONPATH".into(), "/r/src-python".into()), ("PYTHONDONTWRITEBYTECODE".into(), "1".into())],
        }
    }

    #[test]
    fn saved_settings_read_back_and_blank_means_none() {
        assert_eq!(parse_saved(None), Saved::default());
        assert_eq!(parse_saved(Some("nope")), Saved::default());
        assert_eq!(parse_saved(Some(r#"{"program": "  "}"#)), Saved::default());
        assert_eq!(parse_saved(Some(r#"{"program": "/x/agy"}"#)), Saved { program: Some("/x/agy".into()) });
    }

    #[test]
    fn the_search_covers_the_installer_homebrew_and_path() {
        let found = candidates(Some(Path::new("/Users/me")), Some("/a:/b"));
        assert_eq!(found[0], PathBuf::from("/Users/me/.local/bin/agy"));
        assert!(found.contains(&PathBuf::from("/opt/homebrew/bin/agy")));
        assert_eq!(found.last(), Some(&PathBuf::from("/b/agy")));
    }

    #[test]
    fn the_shim_is_registered_through_env_so_agys_environment_reaches_it() {
        let args = add_args(&shim());
        assert_eq!(&args[..4], &["mcp", "add", "vibecut", "--"]);
        assert_eq!(
            &args[4..],
            &["/usr/bin/env", "PYTHONPATH=/r/src-python", "PYTHONDONTWRITEBYTECODE=1", "/opt/homebrew/bin/uv", "run", "--project", "/r", "python"]
        );
    }

    #[test]
    fn registration_is_read_from_agys_mcp_config() {
        let launch = shim();
        assert_eq!(registration(None, &launch), (false, false));
        assert_eq!(registration(Some(""), &launch), (false, false), "agy's own empty file");
        assert_eq!(registration(Some(r#"{"mcpServers": {}}"#), &launch), (false, false));
        let words = registered_command(&launch);
        let current = json!({"mcpServers": {"vibecut": {"command": words[0], "args": words[1..], "disabled": false}}}).to_string();
        assert_eq!(registration(Some(&current), &launch), (true, true));
        let old = json!({"mcpServers": {"vibecut": {"command": "/usr/bin/env", "args": ["PYTHONPATH=/old", "uv"]}}}).to_string();
        assert_eq!(registration(Some(&old), &launch), (true, false));
        let off = json!({"mcpServers": {"vibecut": {"command": words[0], "args": words[1..], "disabled": true}}}).to_string();
        assert_eq!(registration(Some(&off), &launch), (true, false), "a disabled entry isn't usable");
    }

    #[test]
    fn the_models_list_gives_the_gemini_families() {
        let out = "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n\
                   gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngpt-oss-120b-medium\tGPT-OSS\n";
        assert_eq!(parse_models(out), vec!["gemini-4-argon", "gemini-3.8-flash"]);
    }

    #[test]
    fn signed_in_and_out_come_from_agy_models() {
        let mut ok = AntigravityStatus::default();
        parse_models_run(&mut ok, true, "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n", "Fetching available models...\n");
        assert_eq!((ok.signed_in, ok.models.clone(), ok.detail), (Some(true), vec!["gemini-3.8-flash".to_string()], None));
        let mut out = AntigravityStatus::default();
        parse_models_run(&mut out, false, "", "Fetching available models...\nError: Please sign in to view available models.");
        assert_eq!(out.signed_in, Some(false));
        assert!(out.detail.unwrap().contains("isn't signed in"));
        let mut other = AntigravityStatus::default();
        parse_models_run(&mut other, false, "", "Error: network down");
        assert_eq!(other.signed_in, None);
        assert_eq!(other.detail.as_deref(), Some("Error: network down"));
        let mut none = AntigravityStatus::default();
        parse_models_run(&mut none, true, "claude-opus-5-5-low\tClaude\n", "");
        assert!(none.detail.unwrap().contains("no Gemini model"));
    }

    #[test]
    fn a_run_gets_the_program_job_and_folder() {
        let value = setup(Path::new("/u/.local/bin/agy"), "job-1", Path::new("/data/antigravity"));
        assert_eq!(value, json!({"program": "/u/.local/bin/agy", "jobId": "job-1", "workDir": "/data/antigravity"}));
    }
}
