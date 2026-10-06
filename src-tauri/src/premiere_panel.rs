//! Installs VibeCut Agent's Premiere Pro panel (`src-premiere-panel`), adapted from VibeCut's
//! `premiere_panel.rs`. Only when the user presses Install in Settings: the panel's files are copied
//! into Adobe's per-user CEP extensions folder, where Premiere loads it on its next start. Uninstall
//! removes that copy. VibeCut's own panel (`com.vibecut.connect`) is never touched.
//!
//! Until the panel is signed, Premiere only loads it with CEP's `PlayerDebugMode` set. That is the
//! user's setting: it is read here (with `defaults read`, which changes nothing) and shown, never
//! written.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

const BUNDLE_ID: &str = "com.vibecutagent.connect";
/// Every file the panel needs, relative to its folder. Only these are copied.
pub const PANEL_FILES: &[&str] = &[
    "CSXS/manifest.xml",
    "index.html",
    "bridge.js",
    "host.jsx",
    // The docked B-roll panel (Phase 5b), built by `npm run build:panel`.
    "broll/index.html",
    "broll/dist/panel.js",
    "broll/dist/panel.css",
];
/// CEP 11 is Premiere 22–24; CEP 12 is Premiere 25 and later.
const CSXS_DOMAINS: &[&str] = &["com.adobe.CSXS.11", "com.adobe.CSXS.12"];
/// The panel stamps alive.json every second; within this many seconds it counts as running.
const ALIVE_WITHIN_S: f64 = 5.0;

/// The panel's source. Dev builds use the repository's folder; a release bundle ships a copy as
/// resources under `premiere-panel/` (tauri.conf.json). `VIBECUT_AGENT_PREMIERE_PANEL_DIR` overrides both.
pub fn panel_source(app: &AppHandle) -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_PREMIERE_PANEL_DIR") {
        return PathBuf::from(custom);
    }
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src-premiere-panel");
    }
    app.path().resource_dir().map(|dir| dir.join("premiere-panel")).unwrap_or_else(|_| PathBuf::from("premiere-panel"))
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME isn't set".to_string())
}

fn extensions_dir() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support/Adobe/CEP/extensions"))
}

/// The panel's request folder; matches `BRIDGE_DIR` in bridge.js and `default_dir` in premiere_bridge.py.
fn bridge_dir() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_PREMIERE_BRIDGE_DIR") {
        return Ok(PathBuf::from(custom));
    }
    Ok(home()?.join("Library/Application Support/VibeCut Agent/host-bridge/premiere"))
}

/// `ExtensionBundleVersion` from a panel folder's manifest.
pub fn bundle_version(panel: &Path) -> Option<String> {
    let manifest = std::fs::read_to_string(panel.join("CSXS/manifest.xml")).ok()?;
    let rest = manifest.split("ExtensionBundleVersion=\"").nth(1)?;
    Some(rest.split('"').next()?.to_string())
}

/// Copies the panel into `extensions`, replacing an older copy (or a developer's symlink) whole.
/// The new copy is put together beside it first, so a failure leaves the old one in place.
pub fn install_into(source: &Path, extensions: &Path) -> Result<PathBuf, String> {
    for file in PANEL_FILES {
        if !source.join(file).is_file() {
            return Err(format!("The Premiere panel is incomplete: {} is missing from {}", file, source.display()));
        }
    }
    std::fs::create_dir_all(extensions).map_err(|e| format!("Couldn't create {}: {e}", extensions.display()))?;
    let target = extensions.join(BUNDLE_ID);
    let staging = extensions.join(format!(".{BUNDLE_ID}.installing"));
    remove(&staging)?;
    for file in PANEL_FILES {
        let to = staging.join(file);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        std::fs::copy(source.join(file), &to).map_err(|e| format!("Couldn't copy {file}: {e}"))?;
    }
    remove(&target)?;
    std::fs::rename(&staging, &target).map_err(|e| format!("Couldn't install the panel: {e}"))?;
    Ok(target)
}

/// Removes a file, folder or symlink (never what a symlink points to). Missing is fine.
pub fn remove(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    let removed = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    removed.map_err(|e| format!("Couldn't remove {}: {e}", path.display()))
}

/// Whether `alive.json` in `bridge` was stamped (its `time`, in seconds) within `ALIVE_WITHIN_S` of `now`.
pub fn panel_alive(bridge: &Path, now: f64) -> bool {
    let Ok(text) = std::fs::read_to_string(bridge.join("alive.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("time").and_then(serde_json::Value::as_f64))
        .is_some_and(|stamp| (now - stamp).abs() <= ALIVE_WITHIN_S)
}

fn debug_mode_on() -> bool {
    CSXS_DOMAINS.iter().any(|domain| {
        Command::new("/usr/bin/defaults")
            .args(["read", domain, "PlayerDebugMode"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
    })
}

fn premiere_installed() -> bool {
    std::fs::read_dir("/Applications")
        .map(|entries| entries.flatten().any(|e| e.file_name().to_string_lossy().starts_with("Adobe Premiere Pro")))
        .unwrap_or(false)
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PremierePanelStatus {
    pub premiere_installed: bool,
    pub bundled_version: Option<String>,
    pub installed_version: Option<String>,
    pub installed_path: String,
    /// Whether CEP's PlayerDebugMode is 1 for CEP 11 or 12, which an unsigned panel needs.
    pub debug_mode: bool,
    /// Whether the panel is running in Premiere now (its heartbeat is fresh).
    pub running: bool,
}

fn status(source: &Path) -> Result<PremierePanelStatus, String> {
    let target = extensions_dir()?.join(BUNDLE_ID);
    Ok(PremierePanelStatus {
        premiere_installed: premiere_installed(),
        bundled_version: bundle_version(source),
        installed_version: bundle_version(&target),
        installed_path: target.to_string_lossy().into_owned(),
        debug_mode: debug_mode_on(),
        running: panel_alive(&bridge_dir()?, now()),
    })
}

#[tauri::command]
pub async fn premiere_panel_status(app: AppHandle) -> Result<PremierePanelStatus, String> {
    let source = panel_source(&app);
    tauri::async_runtime::spawn_blocking(move || status(&source)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn premiere_panel_install(app: AppHandle) -> Result<PremierePanelStatus, String> {
    let source = panel_source(&app);
    tauri::async_runtime::spawn_blocking(move || {
        install_into(&source, &extensions_dir()?)?;
        status(&source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn premiere_panel_uninstall(app: AppHandle) -> Result<PremierePanelStatus, String> {
    let source = panel_source(&app);
    tauri::async_runtime::spawn_blocking(move || {
        remove(&extensions_dir()?.join(BUNDLE_ID))?;
        status(&source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-panel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_panel(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir.join("CSXS")).unwrap();
        std::fs::write(dir.join("CSXS/manifest.xml"), format!("<ExtensionManifest ExtensionBundleVersion=\"{version}\">")).unwrap();
        for file in PANEL_FILES.iter().filter(|f| !f.starts_with("CSXS")) {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, version).unwrap();
        }
    }

    fn repo_panel() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src-premiere-panel")
    }

    #[test]
    fn the_repositorys_panel_is_complete_versioned_and_not_vibecuts() {
        let source = repo_panel();
        for file in PANEL_FILES {
            assert!(source.join(file).is_file(), "{file} is missing");
        }
        assert_eq!(bundle_version(&source).as_deref(), Some("0.8.0"));
        let manifest = std::fs::read_to_string(source.join("CSXS/manifest.xml")).unwrap();
        assert!(manifest.contains("ExtensionBundleId=\"com.vibecutagent.connect\""));
        assert!(!manifest.contains("com.vibecut.connect\""));
        let bridge = std::fs::read_to_string(source.join("bridge.js")).unwrap();
        assert!(bridge.contains("\"VibeCut Agent\", \"host-bridge\", \"premiere\""), "the panel must use the Agent's own folder");
    }

    #[test]
    fn install_copies_only_the_panel_and_replaces_an_older_copy() {
        let root = scratch("install");
        let (source, extensions) = (root.join("source"), root.join("extensions"));
        fake_panel(&source, "0.2.0");
        std::fs::write(source.join("notes.txt"), "not part of the panel").unwrap();
        fake_panel(&extensions.join(BUNDLE_ID), "0.1.0");
        std::fs::write(extensions.join(BUNDLE_ID).join("stale.js"), "old").unwrap();

        let target = install_into(&source, &extensions).unwrap();
        assert_eq!(bundle_version(&target).as_deref(), Some("0.2.0"));
        assert!(target.join("host.jsx").is_file());
        assert!(!target.join("notes.txt").exists() && !target.join("stale.js").exists());
        assert!(!extensions.join(format!(".{BUNDLE_ID}.installing")).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn install_replaces_a_developer_symlink_without_touching_its_target() {
        let root = scratch("symlink");
        let (source, extensions, linked) = (root.join("source"), root.join("extensions"), root.join("dev-panel"));
        fake_panel(&source, "0.2.0");
        fake_panel(&linked, "0.0.1");
        std::fs::create_dir_all(&extensions).unwrap();
        std::os::unix::fs::symlink(&linked, extensions.join(BUNDLE_ID)).unwrap();

        let target = install_into(&source, &extensions).unwrap();
        assert!(!std::fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
        assert_eq!(bundle_version(&linked).as_deref(), Some("0.0.1"), "the symlink's target is left alone");
        remove(&target).unwrap();
        assert!(!target.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_incomplete_panel_is_refused_and_nothing_changes() {
        let root = scratch("incomplete");
        let (source, extensions) = (root.join("source"), root.join("extensions"));
        fake_panel(&source, "0.2.0");
        std::fs::remove_file(source.join("host.jsx")).unwrap();
        fake_panel(&extensions.join(BUNDLE_ID), "0.1.0");
        assert!(install_into(&source, &extensions).unwrap_err().contains("host.jsx is missing"));
        assert_eq!(bundle_version(&extensions.join(BUNDLE_ID)).as_deref(), Some("0.1.0"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_heartbeat_counts_only_when_fresh() {
        let dir = scratch("alive");
        assert!(!panel_alive(&dir, 100.0));
        std::fs::write(dir.join("alive.json"), r#"{"time": 100.0}"#).unwrap();
        assert!(panel_alive(&dir, 104.0));
        assert!(!panel_alive(&dir, 106.0));
        std::fs::write(dir.join("alive.json"), "not json").unwrap();
        assert!(!panel_alive(&dir, 100.0));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
