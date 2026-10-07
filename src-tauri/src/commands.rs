//! IPC commands for the frontend (`src/lib/ipc.ts`). Anything that spawns a process or touches the
//! filesystem runs on the blocking pool so the UI thread never waits on it.

use crate::state::{AppState, View};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Binaries the About modal reports on, with the flag that prints each one's version.
const DEPENDENCIES: &[(&str, &str)] = &[
    ("ffmpeg", "-version"),
    ("ffprobe", "-version"),
    ("exiftool", "-ver"),
    ("uv", "--version"),
];

/// Where Homebrew and friends install, for when the app is launched from Finder with a bare PATH.
const EXTRA_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

#[derive(Serialize, Debug, PartialEq)]
pub struct DependencyInfo {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct HwAccel {
    pub videotoolbox: bool,
    pub nvenc: bool,
}

#[derive(Serialize, Debug)]
pub struct StoragePaths {
    pub config: Option<String>,
    pub data: Option<String>,
    pub logs: Option<String>,
    /// Past chats and the edit log (chat_store.rs).
    pub history: Option<String>,
}

/// PATH entries followed by the extra install dirs, without duplicates.
fn search_dirs(path_var: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    for extra in EXTRA_BIN_DIRS {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    dirs
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// A tool to run: `override_var` if set, else the first on PATH or in Homebrew's folders (a GUI app
/// opened from Finder has no shell PATH), else the bare name.
fn tool_binary(name: &str, override_var: &str) -> PathBuf {
    if let Some(custom) = std::env::var_os(override_var) {
        return PathBuf::from(custom);
    }
    let path = std::env::var("PATH").ok();
    find_binary(name, &search_dirs(path.as_deref())).unwrap_or_else(|| PathBuf::from(name))
}

/// The ffmpeg the audio sync runs (Phase 6c; `VIBECUT_FFMPEG` overrides it).
pub fn ffmpeg_binary() -> PathBuf {
    tool_binary("ffmpeg", "VIBECUT_FFMPEG")
}

/// The longest a media path may be, and how many files one `media_durations` call reads.
const MAX_DURATION_FILES: usize = 64;

/// A file's length in seconds from ffprobe's container duration, or None when it can't be read.
fn probe_duration(ffprobe: &Path, file: &Path) -> Option<f64> {
    let output = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(file)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0)
}

/// Each media file's length in seconds (null when it can't be read): the agent's sync tools place a
/// whole camera clip and the stretch of a recording under it (Phase 6c).
#[tauri::command]
pub async fn media_durations(paths: Vec<String>) -> Result<Vec<Option<f64>>, String> {
    if paths.len() > MAX_DURATION_FILES {
        return Err(format!("Ask for at most {MAX_DURATION_FILES} files at a time"));
    }
    if let Some(bad) = paths.iter().find(|p| !Path::new(p).is_absolute()) {
        return Err(format!("Media path must be absolute: {bad}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = tool_binary("ffprobe", "VIBECUT_FFPROBE");
        paths.iter().map(|p| probe_duration(&ffprobe, Path::new(p))).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The first `dirs` entry holding an executable `name`.
fn find_binary(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    dirs.iter().map(|dir| dir.join(&file)).find(|candidate| is_executable(candidate))
}

/// A short version string from a tool's version output: "ffmpeg version 7.1 Copyright…" → "7.1",
/// "uv 0.5.4 (Homebrew)" → "0.5.4", "13.10" → "13.10".
fn parse_version(name: &str, output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut words = line.split_whitespace();
    let token = match (words.next(), words.next()) {
        (Some(first), Some("version")) if first == name => words.next(),
        (Some(first), Some(second)) if first == name => Some(second),
        _ => None,
    };
    Some(token.unwrap_or(line).to_string())
}

fn run_capture(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(path).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Hardware encoders compiled into ffmpeg, from `ffmpeg -hide_banner -encoders`.
fn parse_encoders(output: &str) -> HwAccel {
    let has = |encoder: &str| output.split_whitespace().any(|word| word == encoder);
    HwAccel {
        videotoolbox: has("h264_videotoolbox") || has("hevc_videotoolbox"),
        nvenc: has("h264_nvenc") || has("hevc_nvenc"),
    }
}

fn dependency_report() -> Vec<DependencyInfo> {
    let dirs = search_dirs(std::env::var("PATH").ok().as_deref());
    DEPENDENCIES
        .iter()
        .map(|(name, flag)| {
            let path = find_binary(name, &dirs);
            let version = path.as_deref().and_then(|p| run_capture(p, &[flag])).and_then(|out| parse_version(name, &out));
            DependencyInfo { name: name.to_string(), path: path.map(|p| p.display().to_string()), version }
        })
        .collect()
}

fn hardware_report() -> HwAccel {
    let dirs = search_dirs(std::env::var("PATH").ok().as_deref());
    find_binary("ffmpeg", &dirs)
        .and_then(|ffmpeg| run_capture(&ffmpeg, &["-hide_banner", "-encoders"]))
        .map(|out| parse_encoders(&out))
        .unwrap_or_default()
}

#[tauri::command]
pub fn take_pending_view(state: tauri::State<'_, AppState>) -> Option<View> {
    state.take_pending_view()
}

#[tauri::command]
pub async fn dependency_status() -> Result<Vec<DependencyInfo>, String> {
    tauri::async_runtime::spawn_blocking(dependency_report).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hardware_acceleration() -> Result<HwAccel, String> {
    tauri::async_runtime::spawn_blocking(hardware_report).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_paths(app: AppHandle) -> StoragePaths {
    let path = app.path();
    let show = |dir: tauri::Result<PathBuf>| dir.ok().map(|d| d.display().to_string());
    StoragePaths {
        config: show(path.app_config_dir()),
        data: show(path.app_data_dir()),
        logs: show(path.app_log_dir()),
        history: crate::chat_store::history_dir(&app).ok().map(|d| d.display().to_string()),
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn probes_a_files_length_and_reports_an_unreadable_one() {
        let ffmpeg = ffmpeg_binary();
        let dir = std::env::temp_dir().join(format!("vca-durations-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        let made = Command::new(&ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=2.5"]).arg(&wav).status();
        if made.map(|s| !s.success()).unwrap_or(true) {
            return; // no ffmpeg here
        }
        let ffprobe = tool_binary("ffprobe", "VIBECUT_FFPROBE");
        let length = probe_duration(&ffprobe, &wav).unwrap();
        assert!((length - 2.5).abs() < 0.05, "{length}");
        assert_eq!(probe_duration(&ffprobe, &dir.join("missing.wav")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn versions_are_shortened() {
        assert_eq!(parse_version("ffmpeg", "ffmpeg version 7.1 Copyright (c) 2000-2024\nbuilt with"), Some("7.1".into()));
        assert_eq!(parse_version("ffprobe", "ffprobe version n6.0-1 Copyright"), Some("n6.0-1".into()));
        assert_eq!(parse_version("uv", "uv 0.5.4 (Homebrew 2024-11-20)\n"), Some("0.5.4".into()));
        assert_eq!(parse_version("exiftool", "\n13.10\n"), Some("13.10".into()));
        assert_eq!(parse_version("ffmpeg", "   \n"), None);
    }

    #[test]
    fn encoders_are_detected_by_exact_name() {
        let out = " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n V....D libx264 libx264 H.264";
        assert_eq!(parse_encoders(out), HwAccel { videotoolbox: true, nvenc: false });
        let out = " V....D hevc_nvenc NVIDIA NVENC hevc encoder";
        assert_eq!(parse_encoders(out), HwAccel { videotoolbox: false, nvenc: true });
        assert_eq!(parse_encoders(""), HwAccel::default());
    }

    #[test]
    fn search_dirs_keep_path_order_and_add_extras_once() {
        let joined = std::env::join_paths(["/usr/bin", "/opt/homebrew/bin"]).unwrap();
        let dirs = search_dirs(joined.to_str());
        assert_eq!(dirs, vec![PathBuf::from("/usr/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
        assert_eq!(search_dirs(None), vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    }

    #[cfg(unix)]
    #[test]
    fn find_binary_takes_the_first_executable() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("vibecut-agent-find-{}", std::process::id()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("tool"), "").unwrap(); // not executable
        std::fs::write(b.join("tool"), "").unwrap();
        std::fs::set_permissions(b.join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_binary("tool", &[a.clone(), b.clone()]), Some(b.join("tool")));
        assert_eq!(find_binary("missing", &[a, b]), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
