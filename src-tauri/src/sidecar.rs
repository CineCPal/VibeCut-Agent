//! Runs the Python sidecar (`src-python/vibecut_agent`) and streams what it reports.
//!
//! Ported from VibeCut's `src-tauri/src/sidecar.rs`. A run is
//! `uv run --locked --no-dev --project <root> python -u -m vibecut_agent <command>`. The request goes
//! in as JSON on stdin (options and secrets, never argv or the environment); the sidecar answers with
//! one JSON object per line on stdout (`vibecut_agent.protocol`). Each parsed line is forwarded to the
//! frontend as a `sidecar-event`, and the end of the process as a `sidecar-exit`.
//!
//! The frontend never names a program or a script: only the commands in `COMMANDS` can run.
//!
//! Two kinds of run:
//! - One-shot jobs (`sidecar_start`): the request is written, stdin is closed, the command answers
//!   and exits.
//! - The agent session: one long-lived `session` process that Rust starts at launch and owns. Its
//!   stdin stays open so the frontend can send further JSON lines with `sidecar_send`; its state
//!   (`starting` / `ready` / `stopped`) is pushed as `sidecar-session`. It exits when stdin closes,
//!   so it can never outlive the app, and every sidecar is killed on app exit regardless.
//!
//! Every process runs on its own threads; no command waits on Python.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT: &str = "sidecar-event";
pub const EXIT_EVENT: &str = "sidecar-exit";
pub const SESSION_EVENT: &str = "sidecar-session";
/// The job id of the agent session, for `sidecar_send` and in `sidecar-event` payloads.
pub const SESSION_JOB_ID: &str = "agent-session";
const PACKAGE: &str = "vibecut_agent";
/// How long a sidecar gets to stop after SIGTERM before its whole process group is killed.
const KILL_AFTER: Duration = Duration::from_secs(3);
/// Stderr lines kept to explain a failure, and non-protocol stdout lines forwarded as `log` events.
const TAIL_LINES: usize = 200;
const MAX_LOG_EVENTS: usize = 200;
const MAX_LINE_CHARS: usize = 500;

/// One command the frontend may run. Must match `COMMANDS` in `vibecut_agent/headless.py`.
pub struct CommandSpec {
    pub name: &'static str,
    /// Keeps stdin open after the first request (see the module doc comment).
    pub interactive: bool,
    /// Started and owned by Rust only; `sidecar_start` refuses it.
    pub managed: bool,
}

pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "health", interactive: false, managed: false },
    // One conversation with the editing agent; stdin stays open for tool results and later messages.
    CommandSpec { name: "chat", interactive: true, managed: false },
    // The B-roll analyzer (vibecut_agent/broll): technical scoring, and the optional `energy` extra.
    CommandSpec { name: "broll-analyze", interactive: false, managed: false },
    CommandSpec { name: "broll-match", interactive: false, managed: false },
    // The B-roll Library's text search of Spyglass's index (read only).
    CommandSpec { name: "broll-spyglass", interactive: false, managed: false },
    // Local transcription (Phase 6b): mlx-whisper, plus pyannote speaker labels when asked.
    CommandSpec { name: "transcribe", interactive: false, managed: false },
    // Peak levels of media files, for the agent's find_silences (Phase 6b).
    CommandSpec { name: "audio-peaks", interactive: false, managed: false },
    // The Story Editor's one model call (Phase 6d): a story cut from transcripts and a B-roll catalog.
    CommandSpec { name: "assemble", interactive: false, managed: false },
    CommandSpec { name: "session", interactive: true, managed: true },
    // The editor watchers (nle.rs), kept running by Rust.
    CommandSpec { name: "premiere-watch", interactive: true, managed: true },
    CommandSpec { name: "resolve-watch", interactive: true, managed: true },
];

pub fn find_command(name: &str) -> Result<&'static CommandSpec, String> {
    COMMANDS.iter().find(|c| c.name == name).ok_or_else(|| format!("Unknown sidecar command: {name}"))
}

/// Job ids come from the frontend; keep them to a harmless alphabet.
pub fn valid_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding one of these locks leaves plain data behind; keep going with it.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ------------------------------------------------------------------ locating uv and the Python root

pub fn uv_binary() -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_UV") {
        return PathBuf::from(custom);
    }
    // GUI apps launched from Finder do not inherit the shell PATH, so check the usual install dirs.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(Path::new(&home).join(".local/bin/uv"));
    }
    candidates.extend(["/opt/homebrew/bin/uv", "/usr/local/bin/uv", "/usr/bin/uv"].iter().map(PathBuf::from));
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("uv"))
}

/// The uv project holding the sidecar (`pyproject.toml`, `uv.lock`, `src-python/`). Dev builds use
/// the repository; a release bundle ships a copy as resources under `python/` (tauri.conf.json).
/// `VIBECUT_AGENT_PYTHON_ROOT` overrides both.
pub fn python_root(app: &AppHandle) -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_PYTHON_ROOT") {
        return PathBuf::from(custom);
    }
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    }
    app.path().resource_dir().map(|dir| dir.join("python")).unwrap_or_else(|_| PathBuf::from("python"))
}

/// Where uv keeps the virtual environment. A release build must not write into its signed app bundle,
/// so it uses the app data folder; dev builds use the repository's `.venv`.
pub fn uv_environment(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    app.path().app_data_dir().ok().map(|dir| dir.join("python-env"))
}

pub(crate) fn package_dir(root: &Path) -> PathBuf {
    root.join("src-python").join(PACKAGE)
}

/// DaVinci Resolve's bundled Python (Resolve 21.1 and later), which can load Resolve's scripting
/// module. `VIBECUT_RESOLVE_PYTHON` overrides it (the same variable VibeCut reads).
pub fn resolve_python() -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_RESOLVE_PYTHON") {
        return PathBuf::from(custom);
    }
    PathBuf::from("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolvePython")
}

/// PATH for the child: the usual tool folders first, then whatever this process had.
pub fn child_path(home: Option<&str>, existing: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = home {
        parts.push(format!("{home}/.local/bin"));
    }
    parts.extend(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin"].map(String::from));
    if let Some(existing) = existing {
        for part in existing.split(':').filter(|p| !p.is_empty()) {
            if !parts.iter().any(|p| p == part) {
                parts.push(part.to_string());
            }
        }
    }
    parts.join(":")
}

/// Environment variables a sidecar inherits. Everything else, including `GEMINI_API_KEY` and
/// `ANTHROPIC_API_KEY`, is dropped: secrets reach the sidecar through its stdin request only.
pub fn passes_to_child(name: &str) -> bool {
    matches!(
        name,
        "HOME" | "USER" | "LOGNAME" | "TMPDIR" | "LANG" | "LC_ALL" | "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY"
            | "SSL_CERT_FILE" | "SSL_CERT_DIR"
    ) || ["VIBECUT_", "UV_", "HF_", "XDG_"].iter().any(|prefix| name.starts_with(prefix))
}

/// The optional dependency groups (pyproject.toml) a run needs, ported from VibeCut's tool extras:
/// `broll-match` always embeds text and frames with SigLIP 2; `broll-analyze` only when the request
/// turns content-aware scoring on (and never for a `catalog` read, which decodes nothing);
/// `broll-spyglass` embeds the query with SigLIP 2 / CLIP, except for a `catalog` listing; `transcribe`
/// needs mlx-whisper, and pyannote only when it labels speakers (`diarize`).
pub fn extras_for(command: &str, request: &Value) -> Vec<&'static str> {
    let flag = |key: &str| request.get(key).and_then(Value::as_bool) == Some(true);
    match command {
        "broll-match" => vec!["energy"],
        "broll-spyglass" if !flag("catalog") => vec!["energy"],
        "transcribe" if flag("diarize") => vec!["transcribe", "diarize"],
        "transcribe" => vec!["transcribe"],
        "broll-analyze" if flag("enableEnergy") && !flag("catalog") => vec!["energy"],
        _ => Vec::new(),
    }
}

/// The uv arguments for one run. `--locked` keeps a run from re-resolving (and reaching for the
/// network); `--no-dev` keeps test tools out of the environment. An extra is installed on first use
/// (the `energy` one is about 2 GB) and kept, since `uv run` syncs inexactly.
pub fn build_args(root: &Path, command: &str, extras: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = ["run", "--locked", "--no-dev", "--project"].map(String::from).to_vec();
    args.push(root.to_string_lossy().into_owned());
    for extra in extras {
        args.push("--extra".into());
        args.push((*extra).to_string());
    }
    args.extend(["python", "-u", "-m", PACKAGE, command].map(String::from));
    args
}

pub const GEMINI_KEY_ENV: &str = "GEMINI_API_KEY";
pub const CLAUDE_KEY_ENV: &str = "ANTHROPIC_API_KEY";

/// The request as handed to the sidecar. A key sent by the frontend is discarded so one can never be
/// logged or stored on that side. `chat` gets its provider's key from this process's environment
/// (ported from VibeCut's `prepare_request`); a missing `provider` means Gemini.
pub fn prepare_request(command: &str, mut request: Value, gemini_key: Option<&str>, claude_key: Option<&str>) -> Result<Value, String> {
    let Some(object) = request.as_object_mut() else {
        return Err("The request must be a JSON object".into());
    };
    object.remove("apiKey");
    if !needs_llm_key(command) {
        return Ok(request);
    }
    let (key, env, other) = match object.get("provider").and_then(Value::as_str).unwrap_or("gemini") {
        "gemini" => (gemini_key, GEMINI_KEY_ENV, "Claude"),
        "claude" => (claude_key, CLAUDE_KEY_ENV, "Gemini"),
        other => return Err(format!("Unknown AI provider {other:?}")),
    };
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => {
            object.insert("apiKey".into(), Value::String(key.to_string()));
            Ok(request)
        }
        None => Err(format!("{env} is not set. Add it in Settings → API keys, or choose {other}.")),
    }
}

/// The commands that call a model with the chat's provider: the chat itself and the Story Editor.
pub fn needs_llm_key(command: &str) -> bool {
    matches!(command, "chat" | "assemble")
}

/// Puts the Hugging Face token into a `transcribe` request, or takes out any the UI sent.
pub fn set_hf_token(request: &mut Value, token: Option<&str>) {
    if let Some(object) = request.as_object_mut() {
        object.remove("hfToken");
        if let Some(token) = token {
            object.insert("hfToken".into(), Value::String(token.to_string()));
        }
    }
}

/// Puts the Spyglass index Rust resolved into a `broll-spyglass` request, replacing any the UI sent.
pub fn set_index_path(request: &mut Value, index: &Path) {
    if let Some(object) = request.as_object_mut() {
        object.insert("indexPath".into(), Value::String(index.to_string_lossy().into_owned()));
    }
}

// ----------------------------------------------------------------------- reading what comes back

#[derive(Debug, PartialEq)]
pub enum Line {
    /// A protocol event: a JSON object with a string `type`.
    Event(Value),
    /// Anything else the sidecar printed.
    Log(String),
}

pub fn classify_line(line: &str) -> Option<Line> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) if value.get("type").is_some_and(Value::is_string) => Some(Line::Event(value)),
        _ => Some(Line::Log(truncate(trimmed))),
    }
}

fn truncate(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        line.to_string()
    } else {
        let mut cut: String = line.chars().take(MAX_LINE_CHARS).collect();
        cut.push('…');
        cut
    }
}

#[derive(Default)]
struct Tail(VecDeque<String>);

impl Tail {
    fn push(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if self.0.len() == TAIL_LINES {
            self.0.pop_front();
        }
        self.0.push_back(truncate(line));
    }

    /// The last few lines, the ones that usually say why a run failed.
    fn summary(&self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        let start = self.0.len().saturating_sub(6);
        Some(self.0.iter().skip(start).cloned().collect::<Vec<_>>().join("\n"))
    }
}

// ---------------------------------------------------------------------------------------- jobs

/// One running sidecar: lets another command stop it or write to it.
#[derive(Default)]
pub struct SidecarJob {
    cancelled: AtomicBool,
    finished: AtomicBool,
    /// The child leads its own process group, so `uv` and the Python it starts stop together.
    group: Mutex<Option<i32>>,
    /// Kept only for an interactive run, so `sidecar_send` can write more lines. Dropped (closing
    /// the pipe) when the run ends.
    stdin: Mutex<Option<ChildStdin>>,
}

impl SidecarJob {
    fn signal(&self, signal: i32) {
        #[cfg(unix)]
        if let Some(group) = *lock(&self.group) {
            // SAFETY: kill(2) with a negative pid signals a process group; no memory is touched.
            unsafe {
                libc::kill(-group, signal);
            }
        }
        #[cfg(not(unix))]
        let _ = signal;
    }

    /// Asks the sidecar to stop, and kills it if it has not within `KILL_AFTER`.
    pub fn cancel(self: &Arc<Self>) {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            self.signal(libc::SIGTERM);
            let job = Arc::clone(self);
            std::thread::spawn(move || {
                std::thread::sleep(KILL_AFTER);
                if !job.finished.load(Ordering::SeqCst) {
                    job.signal(libc::SIGKILL);
                }
            });
        }
    }

    /// Kills at once; for app exit.
    pub fn kill(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Writes one JSON line to an interactive run. `Ok(false)` if it has no open stdin.
    pub(crate) fn send_line(&self, message: &Value) -> Result<bool, String> {
        let mut guard = lock(&self.stdin);
        let Some(stdin) = guard.as_mut() else {
            return Ok(false);
        };
        let mut line = message.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map(|_| true)
            .map_err(|e| format!("Could not send the message to the sidecar: {e}"))
    }
}

#[derive(Default)]
pub struct SidecarJobs {
    running: Mutex<HashMap<String, Arc<SidecarJob>>>,
}

impl SidecarJobs {
    pub(crate) fn insert(&self, job_id: &str, job: &Arc<SidecarJob>) -> Result<(), String> {
        let mut running = lock(&self.running);
        if running.contains_key(job_id) {
            return Err("A job with this id is already running".into());
        }
        running.insert(job_id.to_string(), Arc::clone(job));
        Ok(())
    }

    pub(crate) fn get(&self, job_id: &str) -> Option<Arc<SidecarJob>> {
        lock(&self.running).get(job_id).cloned()
    }

    /// Removes `job_id` only if it still maps to `job`, so a finished run never removes its successor.
    pub(crate) fn remove_if_same(&self, job_id: &str, job: &Arc<SidecarJob>) {
        let mut running = lock(&self.running);
        if running.get(job_id).is_some_and(|current| Arc::ptr_eq(current, job)) {
            running.remove(job_id);
        }
    }

    /// Stops every sidecar; the app is quitting and must not leave Python processes behind.
    pub fn kill_all(&self) {
        for job in lock(&self.running).values() {
            job.kill();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEvent<'a> {
    job_id: &'a str,
    command: &'a str,
    event: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarExit {
    pub job_id: String,
    pub code: Option<i32>,
    pub cancelled: bool,
    /// Why it failed, when the sidecar did not say so itself.
    pub message: Option<String>,
}

/// The program, arguments and environment for one run, kept separate from spawning for tests.
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
}

impl Launch {
    /// The environment every run gets: the allow-listed variables, a usable PATH, and the package on
    /// PYTHONPATH. No .pyc files, so a release build never writes into its signed bundle.
    fn base_envs(root: &Path) -> Vec<(String, String)> {
        let home = std::env::var("HOME").ok();
        let mut envs: Vec<(String, String)> = std::env::vars().filter(|(name, _)| passes_to_child(name)).collect();
        envs.push(("PATH".into(), child_path(home.as_deref(), std::env::var("PATH").ok().as_deref())));
        envs.push(("PYTHONPATH".into(), root.join("src-python").to_string_lossy().into_owned()));
        envs.push(("PYTHONUNBUFFERED".into(), "1".into()));
        envs.push(("PYTHONIOENCODING".into(), "utf-8".into()));
        envs.push(("PYTHONDONTWRITEBYTECODE".into(), "1".into()));
        envs
    }

    /// A command run by uv in the project's locked environment, with the extras it needs.
    pub fn for_command(root: &Path, environment: Option<&Path>, command: &str, extras: &[&str]) -> Launch {
        let mut envs = Launch::base_envs(root);
        if let Some(environment) = environment {
            envs.push(("UV_PROJECT_ENVIRONMENT".into(), environment.to_string_lossy().into_owned()));
        }
        Launch { program: uv_binary(), args: build_args(root, command, extras), cwd: root.to_path_buf(), envs }
    }

    /// `resolve-watch`, run by Resolve's own Python, which has no access to the uv environment; the
    /// code it runs (`vibecut_agent.nle`) is standard library only. ResolvePython runs isolated, so it
    /// ignores PYTHONPATH and the PYTHON* variables: `src-python/resolve_watch.py` puts the package on
    /// `sys.path` itself, and `-u`/`-B` stand in for unbuffered output and no .pyc files.
    pub fn for_resolve(root: &Path) -> Launch {
        let script = root.join("src-python").join("resolve_watch.py");
        Launch {
            program: resolve_python(),
            args: vec!["-u".into(), "-B".into(), script.to_string_lossy().into_owned()],
            cwd: root.to_path_buf(),
            envs: Launch::base_envs(root),
        }
    }

    fn spawn(&self) -> Result<Child, String> {
        let mut process = Command::new(&self.program);
        process
            .args(&self.args)
            .current_dir(&self.cwd)
            .env_clear()
            .envs(self.envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        let is_uv = self.program.file_name().is_some_and(|name| name == "uv");
        process.spawn().map_err(|e| match (e.kind(), is_uv) {
            (ErrorKind::NotFound, true) => "uv not found. Install it (https://docs.astral.sh/uv/) or set VIBECUT_UV".to_string(),
            (ErrorKind::NotFound, false) => format!("{} not found", self.program.display()),
            _ => format!("Could not start the sidecar: {e}"),
        })
    }
}

/// Starts `launch` and registers it as `job`. The child's pid becomes the job's process group.
pub(crate) fn start_child(launch: &Launch, job: &Arc<SidecarJob>) -> Result<Child, String> {
    let child = launch.spawn()?;
    *lock(&job.group) = Some(child.id() as i32);
    Ok(child)
}

/// Writes the request, reads the sidecar to the end calling `on_event` for each event, and reports
/// how it ended. Blocks; always run on its own thread.
pub fn pump(
    job_id: &str,
    job: &Arc<SidecarJob>,
    mut child: Child,
    request: &Value,
    interactive: bool,
    mut on_event: impl FnMut(Value),
) -> SidecarExit {
    let stdin = child.stdin.take();
    let writer = if interactive {
        // The first request is one line; the pipe stays open on the job for `sidecar_send`.
        if let Some(stdin) = stdin {
            *lock(&job.stdin) = Some(stdin);
            let _ = job.send_line(request);
        }
        None
    } else {
        // Written on its own thread so a sidecar that starts reading late can never stall this one.
        let request = request.to_string();
        Some(std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(request.as_bytes());
            }
        }))
    };

    let tail = Arc::new(Mutex::new(Tail::default()));
    let stderr = child.stderr.take();
    let stderr_tail = Arc::clone(&tail);
    // Drained on its own thread so a chatty run (uv's install progress) can never block on a full pipe.
    let stderr_reader = std::thread::spawn(move || {
        if let Some(mut pipe) = stderr {
            let mut text = String::new();
            let mut buffer = [0u8; 4096];
            while let Ok(read) = pipe.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                text.push_str(&String::from_utf8_lossy(&buffer[..read]));
                // Progress bars redraw with carriage returns, so split on those as well.
                while let Some(end) = text.find(['\n', '\r']) {
                    let line: String = text.drain(..=end).collect();
                    lock(&stderr_tail).push(&line);
                }
            }
            lock(&stderr_tail).push(&text);
        }
    });

    let mut saw_error = false;
    let mut logs = 0usize;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match classify_line(&line) {
                Some(Line::Event(event)) => {
                    saw_error |= event.get("type").and_then(Value::as_str) == Some("error");
                    on_event(event);
                }
                Some(Line::Log(text)) if logs < MAX_LOG_EVENTS => {
                    logs += 1;
                    lock(&tail).push(&text);
                    on_event(serde_json::json!({ "type": "log", "line": text }));
                }
                _ => {}
            }
        }
    }

    let status = child.wait();
    job.finished.store(true, Ordering::SeqCst);
    *lock(&job.stdin) = None;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let _ = stderr_reader.join();

    let cancelled = job.is_cancelled();
    let code = status.as_ref().ok().and_then(|s| s.code());
    let succeeded = status.as_ref().is_ok_and(|s| s.success());
    let message = if cancelled || succeeded || saw_error {
        None
    } else {
        Some(lock(&tail).summary().unwrap_or_else(|| "The sidecar stopped without a message".into()))
    };
    SidecarExit { job_id: job_id.to_string(), code, cancelled, message }
}

fn emit_event(app: &AppHandle, job_id: &str, command: &str, event: Value) {
    let _ = app.emit(EVENT, SidecarEvent { job_id, command, event });
}

// ------------------------------------------------------------------------------- agent session

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Starting,
    Ready,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub state: SessionState,
    /// The sidecar's package version and Python version, once it is ready.
    pub version: Option<String>,
    pub python: Option<String>,
    /// Why it stopped, if it did not stop cleanly.
    pub message: Option<String>,
}

impl SessionStatus {
    fn starting() -> Self {
        SessionStatus { state: SessionState::Starting, version: None, python: None, message: None }
    }

    fn stopped(message: Option<String>) -> Self {
        SessionStatus { state: SessionState::Stopped, version: None, python: None, message }
    }

    /// The status after a `ready` event.
    fn ready(event: &Value) -> Self {
        let text = |key: &str| event.get(key).and_then(Value::as_str).map(String::from);
        SessionStatus { state: SessionState::Ready, version: text("version"), python: text("python"), message: None }
    }

    /// The status after the session's process ended.
    fn after_exit(exit: &SidecarExit, last_error: Option<String>) -> Self {
        let message = if exit.cancelled {
            None
        } else {
            exit.message.clone().or(last_error).or_else(|| match exit.code {
                Some(0) => None,
                Some(code) => Some(format!("The agent session exited with code {code}")),
                None => Some("The agent session was killed".into()),
            })
        };
        SessionStatus::stopped(message)
    }
}

/// The agent session's state. `generation` changes on every start, so a run that is still winding
/// down after a restart can't overwrite its successor's status.
pub struct AgentSession {
    status: Mutex<SessionStatus>,
    generation: AtomicU64,
}

impl Default for AgentSession {
    fn default() -> Self {
        AgentSession { status: Mutex::new(SessionStatus::stopped(None)), generation: AtomicU64::new(0) }
    }
}

impl AgentSession {
    pub fn status(&self) -> SessionStatus {
        lock(&self.status).clone()
    }

    /// Sets the status if `generation` is still current. Returns whether it did.
    fn set_if_current(&self, generation: u64, status: SessionStatus) -> bool {
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        *lock(&self.status) = status;
        true
    }
}

fn publish_session(app: &AppHandle, session: &AgentSession, generation: u64, status: SessionStatus) {
    if session.set_if_current(generation, status.clone()) {
        let _ = app.emit(SESSION_EVENT, status);
    }
}

/// Starts the agent session, replacing (and stopping) any session already running.
pub fn start_session(app: &AppHandle) {
    let jobs = app.state::<SidecarJobs>();
    let session = app.state::<AgentSession>();
    let generation = session.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(previous) = jobs.get(SESSION_JOB_ID) {
        jobs.remove_if_same(SESSION_JOB_ID, &previous);
        previous.cancel();
    }

    publish_session(app, &session, generation, SessionStatus::starting());

    let root = python_root(app);
    if !package_dir(&root).join("__main__.py").is_file() {
        let message = format!("The agent sidecar is not installed at {}", package_dir(&root).display());
        publish_session(app, &session, generation, SessionStatus::stopped(Some(message)));
        return;
    }
    let launch = Launch::for_command(&root, uv_environment(app).as_deref(), "session", &[]);
    let job = Arc::new(SidecarJob::default());
    if let Err(message) = jobs.insert(SESSION_JOB_ID, &job) {
        publish_session(app, &session, generation, SessionStatus::stopped(Some(message)));
        return;
    }
    let child = match start_child(&launch, &job) {
        Ok(child) => child,
        Err(message) => {
            jobs.remove_if_same(SESSION_JOB_ID, &job);
            publish_session(app, &session, generation, SessionStatus::stopped(Some(message)));
            return;
        }
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let session = app.state::<AgentSession>();
        let mut last_error: Option<String> = None;
        let exit = pump(SESSION_JOB_ID, &job, child, &serde_json::json!({}), true, |event| {
            match event.get("type").and_then(Value::as_str) {
                Some("ready") => publish_session(&app, &session, generation, SessionStatus::ready(&event)),
                Some("error") => last_error = event.get("message").and_then(Value::as_str).map(String::from),
                _ => {}
            }
            emit_event(&app, SESSION_JOB_ID, "session", event);
        });
        app.state::<SidecarJobs>().remove_if_same(SESSION_JOB_ID, &job);
        publish_session(&app, &session, generation, SessionStatus::after_exit(&exit, last_error));
        let _ = app.emit(EXIT_EVENT, exit);
    });
}

// ------------------------------------------------------------------------------------ commands

/// Starts a one-shot sidecar job. Returns once it is running; progress and the result arrive as
/// events. The job id is chosen by the frontend so it can be listening before the first event.
#[tauri::command]
pub async fn sidecar_start(
    app: AppHandle,
    jobs: State<'_, SidecarJobs>,
    job_id: String,
    command: String,
    request: Value,
) -> Result<(), String> {
    if !valid_job_id(&job_id) || job_id == SESSION_JOB_ID {
        return Err("Invalid job id".into());
    }
    let spec = find_command(&command)?;
    if spec.managed {
        return Err(format!("{command} is started by the app, not on request"));
    }
    // The environment first, then the Keychain (secrets.rs); only a chat or a Story Editor run is given one.
    let store = app.state::<crate::secrets::Keys>();
    let (gemini_key, claude_key) = if needs_llm_key(spec.name) {
        (
            crate::secrets::resolve(GEMINI_KEY_ENV, store.0.as_ref()).map(|(key, _)| key),
            crate::secrets::resolve(CLAUDE_KEY_ENV, store.0.as_ref()).map(|(key, _)| key),
        )
    } else {
        (None, None)
    };
    let mut request = prepare_request(spec.name, request, gemini_key.as_deref(), claude_key.as_deref())?;
    if spec.name == "transcribe" {
        // The Hugging Face token goes only to a run that labels speakers, and only from here.
        let wants = request.get("diarize").and_then(Value::as_bool) == Some(true);
        let token = if wants {
            crate::secrets::resolve(crate::secrets::HF_TOKEN_ENV, store.0.as_ref()).map(|(token, _)| token)
        } else {
            None
        };
        set_hf_token(&mut request, token.as_deref());
    }
    if spec.name == "broll-spyglass" {
        // The same index the Library's folders were read from (spyglass.rs), never one the webview names.
        let index = crate::spyglass::index_for(&app).ok_or("Spyglass has no index on this computer.")?;
        set_index_path(&mut request, &index);
    }
    let root = python_root(&app);
    let launch = Launch::for_command(&root, uv_environment(&app).as_deref(), spec.name, &extras_for(spec.name, &request));

    let job = Arc::new(SidecarJob::default());
    jobs.insert(&job_id, &job)?;
    let child = match start_child(&launch, &job) {
        Ok(child) => child,
        Err(message) => {
            jobs.remove_if_same(&job_id, &job);
            return Err(message);
        }
    };

    let interactive = spec.interactive;
    std::thread::spawn(move || {
        let exit = pump(&job_id, &job, child, &request, interactive, |event| emit_event(&app, &job_id, &command, event));
        app.state::<SidecarJobs>().remove_if_same(&job_id, &job);
        let _ = app.emit(EXIT_EVENT, exit);
    });
    Ok(())
}

/// Stops a job (or the agent session). Does nothing if it has already ended.
#[tauri::command]
pub fn sidecar_cancel(jobs: State<'_, SidecarJobs>, job_id: String) {
    if let Some(job) = jobs.get(&job_id) {
        job.cancel();
    }
}

/// Sends one more JSON line to a running interactive job, such as the agent session. Does nothing if
/// it has already ended; errors only if its pipe could not be written.
#[tauri::command]
pub fn sidecar_send(jobs: State<'_, SidecarJobs>, job_id: String, message: Value) -> Result<(), String> {
    if !message.is_object() {
        return Err("The message must be a JSON object".into());
    }
    // Later lines never carry a key: the sidecar already has it from its first request.
    let message = prepare_request("", message, None, None)?;
    match jobs.get(&job_id) {
        Some(job) => job.send_line(&message).map(|_| ()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn sidecar_session_status(session: State<'_, AgentSession>) -> SessionStatus {
    session.status()
}

/// Stops the agent session (if running) and starts a fresh one.
#[tauri::command]
pub async fn sidecar_session_restart(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_session(&app)).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarInfo {
    pub uv_path: String,
    pub python_root: String,
    pub installed: bool,
    /// Where uv keeps the virtual environment; `None` means the project's own `.venv`.
    pub environment: Option<String>,
}

/// Where the sidecar lives, for the About and Settings panels.
#[tauri::command]
pub fn sidecar_info(app: AppHandle) -> SidecarInfo {
    let root = python_root(&app);
    SidecarInfo {
        uv_path: uv_binary().to_string_lossy().into_owned(),
        installed: package_dir(&root).join("__main__.py").is_file(),
        python_root: root.to_string_lossy().into_owned(),
        environment: uv_environment(&app).map(|p| p.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_listed_commands_run_and_session_is_managed() {
        assert!(!find_command("health").unwrap().managed);
        let session = find_command("session").unwrap();
        assert!(session.interactive && session.managed);
        for watcher in ["premiere-watch", "resolve-watch"] {
            let spec = find_command(watcher).unwrap();
            assert!(spec.interactive && spec.managed, "{watcher} is Rust's to run");
        }
        assert!(find_command("rm").is_err());
    }

    #[test]
    fn job_ids_are_restricted() {
        assert!(valid_job_id("job-1_a"));
        assert!(!valid_job_id(""));
        assert!(!valid_job_id("../etc"));
        assert!(!valid_job_id(&"a".repeat(65)));
    }

    #[test]
    fn args_run_the_package_module_locked() {
        let args = build_args(Path::new("/app/python"), "health", &[]);
        assert_eq!(args, ["run", "--locked", "--no-dev", "--project", "/app/python", "python", "-u", "-m", "vibecut_agent", "health"]);
        let args = build_args(Path::new("/r"), "broll-match", &["energy"]);
        assert_eq!(&args[5..7], ["--extra", "energy"]);
    }

    #[test]
    fn only_content_aware_broll_runs_install_the_energy_extra() {
        assert_eq!(extras_for("broll-match", &json!({})), vec!["energy"]);
        assert_eq!(extras_for("broll-analyze", &json!({"enableEnergy": true})), vec!["energy"]);
        assert!(extras_for("broll-analyze", &json!({"enableEnergy": false})).is_empty());
        assert!(extras_for("broll-analyze", &json!({"enableEnergy": true, "catalog": true})).is_empty());
        assert!(extras_for("chat", &json!({"enableEnergy": true})).is_empty());
        assert_eq!(extras_for("broll-spyglass", &json!({"clipIds": [1]})), vec!["energy"]);
        assert_eq!(extras_for("transcribe", &json!({"videos": []})), vec!["transcribe"]);
        assert_eq!(extras_for("transcribe", &json!({"diarize": true})), vec!["transcribe", "diarize"]);
        let mut sent = json!({"videos": ["/a.mov"], "hfToken": "from-the-ui"});
        set_hf_token(&mut sent, None);
        assert_eq!(sent, json!({"videos": ["/a.mov"]}), "the UI never supplies the token");
        set_hf_token(&mut sent, Some("hf_x"));
        assert_eq!(sent["hfToken"], "hf_x");
        let mut request = json!({"clipIds": [1], "indexPath": "/elsewhere.sqlite"});
        set_index_path(&mut request, Path::new("/suite/spyglass_index.sqlite"));
        assert_eq!(request["indexPath"], "/suite/spyglass_index.sqlite");
        assert!(extras_for("broll-spyglass", &json!({"clipIds": [1], "catalog": true})).is_empty());
    }

    #[test]
    fn secrets_do_not_pass_to_the_child_environment() {
        assert!(passes_to_child("HOME"));
        assert!(passes_to_child("UV_CACHE_DIR"));
        assert!(passes_to_child("VIBECUT_UV"));
        assert!(!passes_to_child("GEMINI_API_KEY"));
        assert!(!passes_to_child("ANTHROPIC_API_KEY"));
        assert!(!passes_to_child("AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn launch_sets_pythonpath_and_environment() {
        let launch = Launch::for_command(Path::new("/r"), Some(Path::new("/data/python-env")), "health", &[]);
        let env = |name: &str| launch.envs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
        assert_eq!(env("PYTHONPATH"), Some("/r/src-python"));
        assert_eq!(env("UV_PROJECT_ENVIRONMENT"), Some("/data/python-env"));
        assert_eq!(env("GEMINI_API_KEY"), None);
        assert_eq!(launch.cwd, PathBuf::from("/r"));
    }

    #[test]
    fn resolve_runs_the_launcher_script_with_resolves_python_and_no_uv() {
        let launch = Launch::for_resolve(Path::new("/r"));
        assert!(launch.program.ends_with("ResolvePython"));
        assert_eq!(launch.args, ["-u", "-B", "/r/src-python/resolve_watch.py"]);
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-python/resolve_watch.py");
        assert!(script.is_file(), "the launcher must exist where for_resolve points");
        let env = |name: &str| launch.envs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
        assert_eq!(env("PYTHONPATH"), Some("/r/src-python"));
        assert_eq!(env("PYTHONDONTWRITEBYTECODE"), Some("1"));
        assert_eq!(env("UV_PROJECT_ENVIRONMENT"), None);
    }

    #[test]
    fn child_path_puts_tool_dirs_first_without_duplicates() {
        let path = child_path(Some("/Users/me"), Some("/usr/bin:/custom/bin:"));
        assert_eq!(path, "/Users/me/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/custom/bin");
    }

    #[test]
    fn requests_must_be_objects_and_lose_any_api_key() {
        assert_eq!(prepare_request("health", json!({"apiKey": "secret", "a": 1}), Some("g"), None).unwrap(), json!({"a": 1}));
        assert!(prepare_request("health", json!([1]), None, None).is_err());
    }

    #[test]
    fn chat_gets_its_providers_key_from_the_environment_only() {
        let sent = json!({"apiKey": "from-the-ui", "userMessage": "hi"});
        let gemini = prepare_request("chat", sent.clone(), Some(" g-key "), Some("c-key")).unwrap();
        assert_eq!(gemini["apiKey"], "g-key");
        let claude = prepare_request("chat", json!({"provider": "claude"}), Some("g-key"), Some("c-key")).unwrap();
        assert_eq!(claude["apiKey"], "c-key");

        let missing = prepare_request("chat", json!({"provider": "claude"}), Some("g-key"), Some("  ")).unwrap_err();
        assert!(missing.starts_with("ANTHROPIC_API_KEY is not set") && missing.ends_with("or choose Gemini."));
        assert!(prepare_request("chat", json!({}), None, None).unwrap_err().starts_with("GEMINI_API_KEY is not set"));
        assert!(prepare_request("chat", json!({"provider": "openai"}), Some("g"), Some("c")).is_err());
    }

    #[test]
    fn the_story_editor_gets_the_chat_providers_key() {
        let claude = prepare_request("assemble", json!({"provider": "claude", "apiKey": "ui"}), Some("g-key"), Some("c-key")).unwrap();
        assert_eq!(claude["apiKey"], "c-key");
        let gemini = prepare_request("assemble", json!({}), Some("g-key"), None).unwrap();
        assert_eq!(gemini["apiKey"], "g-key");
        assert!(prepare_request("assemble", json!({}), None, Some("c-key")).is_err());
        assert!(prepare_request("transcribe", json!({"apiKey": "ui"}), Some("g-key"), None).unwrap().get("apiKey").is_none());
    }

    #[test]
    fn lines_are_events_only_with_a_string_type() {
        assert_eq!(classify_line(r#"{"type":"ready"}"#), Some(Line::Event(json!({"type": "ready"}))));
        assert_eq!(classify_line(r#"{"type":3}"#), Some(Line::Log(r#"{"type":3}"#.into())));
        assert_eq!(classify_line("Installed 3 packages"), Some(Line::Log("Installed 3 packages".into())));
        assert_eq!(classify_line("   "), None);
        let Some(Line::Log(long)) = classify_line(&"x".repeat(600)) else { panic!() };
        assert_eq!(long.chars().count(), MAX_LINE_CHARS + 1);
    }

    #[test]
    fn tail_summarizes_the_last_lines() {
        let mut tail = Tail::default();
        assert_eq!(tail.summary(), None);
        for i in 0..10 {
            tail.push(&format!("line {i}"));
        }
        tail.push("  ");
        assert_eq!(tail.summary().unwrap(), "line 4\nline 5\nline 6\nline 7\nline 8\nline 9");
    }

    #[test]
    fn session_status_after_exit() {
        let exit = |code, cancelled, message: Option<&str>| SidecarExit {
            job_id: SESSION_JOB_ID.into(),
            code,
            cancelled,
            message: message.map(String::from),
        };
        assert_eq!(SessionStatus::after_exit(&exit(Some(0), false, None), None).message, None);
        assert_eq!(SessionStatus::after_exit(&exit(None, true, None), None).message, None);
        assert_eq!(SessionStatus::after_exit(&exit(Some(1), false, Some("Traceback")), None).message.as_deref(), Some("Traceback"));
        assert_eq!(SessionStatus::after_exit(&exit(Some(2), false, None), Some("Bad request".into())).message.as_deref(), Some("Bad request"));
        assert_eq!(
            SessionStatus::after_exit(&exit(Some(3), false, None), None).message.as_deref(),
            Some("The agent session exited with code 3")
        );
    }

    #[test]
    fn ready_status_reads_versions() {
        let status = SessionStatus::ready(&json!({"type": "ready", "version": "0.1.0", "python": "3.14.0"}));
        assert_eq!(status.state, SessionState::Ready);
        assert_eq!(status.version.as_deref(), Some("0.1.0"));
        assert_eq!(status.python.as_deref(), Some("3.14.0"));
    }

    #[test]
    fn stale_generations_do_not_overwrite_the_status() {
        let session = AgentSession::default();
        session.generation.store(2, Ordering::SeqCst);
        assert!(!session.set_if_current(1, SessionStatus::starting()));
        assert_eq!(session.status().state, SessionState::Stopped);
        assert!(session.set_if_current(2, SessionStatus::starting()));
        assert_eq!(session.status().state, SessionState::Starting);
    }

    #[test]
    fn jobs_remove_only_the_same_run() {
        let jobs = SidecarJobs::default();
        let first = Arc::new(SidecarJob::default());
        let second = Arc::new(SidecarJob::default());
        jobs.insert("j", &first).unwrap();
        assert!(jobs.insert("j", &second).is_err());
        jobs.remove_if_same("j", &second);
        assert!(jobs.get("j").is_some());
        jobs.remove_if_same("j", &first);
        assert!(jobs.get("j").is_none());
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Launch {
        Launch { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], cwd: std::env::temp_dir(), envs: vec![] }
    }

    #[cfg(unix)]
    #[test]
    fn pump_forwards_events_and_logs_and_reports_the_exit() {
        let job = Arc::new(SidecarJob::default());
        let child = start_child(&shell(r#"read req; echo '{"type":"result","got":'"$req"'}'; echo plain text; exit 0"#), &job).unwrap();
        let mut events = Vec::new();
        let exit = pump("j", &job, child, &json!({"a": 1}), false, |e| events.push(e));
        assert_eq!(events, vec![json!({"type": "result", "got": {"a": 1}}), json!({"type": "log", "line": "plain text"})]);
        assert_eq!(exit, SidecarExit { job_id: "j".into(), code: Some(0), cancelled: false, message: None });
    }

    #[cfg(unix)]
    #[test]
    fn pump_explains_a_silent_failure_from_stderr() {
        let job = Arc::new(SidecarJob::default());
        let child = start_child(&shell("echo 'ModuleNotFoundError: vibecut_agent' >&2; exit 1"), &job).unwrap();
        let exit = pump("j", &job, child, &json!({}), false, |_| {});
        assert_eq!(exit.code, Some(1));
        assert_eq!(exit.message.as_deref(), Some("ModuleNotFoundError: vibecut_agent"));
    }

    #[cfg(unix)]
    #[test]
    fn interactive_runs_accept_more_lines_until_stdin_closes() {
        let job = Arc::new(SidecarJob::default());
        let child = start_child(&shell(r#"while read line; do echo "{\"type\":\"echo\",\"line\":$line}"; done"#), &job).unwrap();
        let sender = Arc::clone(&job);
        let mut events = Vec::new();
        let exit = pump("j", &job, child, &json!({"n": 0}), true, |event| {
            let n = event["line"]["n"].as_i64().unwrap();
            events.push(n);
            if n < 2 {
                sender.send_line(&json!({"n": n + 1})).unwrap();
            } else {
                // Closing stdin ends the loop, as quitting the app ends the session.
                *lock(&sender.stdin) = None;
            }
        });
        assert_eq!(events, vec![0, 1, 2]);
        assert_eq!(exit.code, Some(0));
        assert!(!job.send_line(&json!({})).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn cancel_stops_the_process_group() {
        let job = Arc::new(SidecarJob::default());
        let child = start_child(&shell("sleep 30"), &job).unwrap();
        let canceller = Arc::clone(&job);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            canceller.cancel();
        });
        let exit = pump("j", &job, child, &json!({}), false, |_| {});
        assert!(exit.cancelled);
        assert_eq!(exit.message, None);
    }
}
