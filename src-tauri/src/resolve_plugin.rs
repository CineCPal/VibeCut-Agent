//! Installs VibeCut Agent's Workflow Integration plugin for DaVinci Resolve Studio
//! (`src-resolve-plugin/`, `com.vibecutagent.resolve`; PLAN.md "In-host panels"), after VibeCut's
//! resolve_panel.rs (removed in its commit 9e056a4). Only when the user presses Install in Settings →
//! Editors: the plugin's files are copied into Resolve's Workflow Integration Plugins folder, which
//! Resolve scans when it starts; the window then opens from Workspace › Workflow Integrations › VibeCut
//! Agent. Uninstall removes that copy. VibeCut's own plugin (`com.vibecut.agent`) is never touched.

use crate::nle::Host;
use crate::premiere_panel::remove;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const BUNDLE_ID: &str = "com.vibecutagent.resolve";
/// Every file the plugin needs, relative to its folder. Only these are copied.
pub const PLUGIN_FILES: &[&str] = &[
    "manifest.xml",
    "package.json",
    "main.js",
    "preload.js",
    "files.js",
    "index.html",
    // The VibeCut Agent panel, built by `npm run build:panel`.
    "dist/panel.js",
    "dist/panel.css",
];
const RESOLVE_APP: &str = "/Applications/DaVinci Resolve/DaVinci Resolve.app";

/// The plugin's source. Dev builds use the repository's folder; a release bundle ships a copy as
/// resources under `resolve-plugin/` (tauri.conf.json). `VIBECUT_AGENT_RESOLVE_PLUGIN_DIR` overrides both.
pub fn plugin_source(app: &AppHandle) -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_RESOLVE_PLUGIN_DIR") {
        return PathBuf::from(custom);
    }
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src-resolve-plugin");
    }
    app.path().resource_dir().map(|dir| dir.join("resolve-plugin")).unwrap_or_else(|_| PathBuf::from("resolve-plugin"))
}

/// Where Resolve looks for Workflow Integration plugins on macOS (`VIBECUT_AGENT_RESOLVE_PLUGIN_ROOT`
/// overrides it).
fn plugins_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_RESOLVE_PLUGIN_ROOT") {
        return PathBuf::from(custom);
    }
    PathBuf::from("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins")
}

/// `<Version>` from a plugin folder's manifest.
pub fn plugin_version(plugin: &Path) -> Option<String> {
    let manifest = std::fs::read_to_string(plugin.join("manifest.xml")).ok()?;
    let rest = manifest.split("<Version>").nth(1)?;
    let version = rest.split("</Version>").next()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// Copies the plugin into `root`, replacing an older copy (or a developer's symlink) whole. The new
/// copy is put together beside it first, so a failure leaves the old one in place.
pub fn install_into(source: &Path, root: &Path) -> Result<PathBuf, String> {
    for file in PLUGIN_FILES {
        if source.join(file).is_file() {
            continue;
        }
        return Err(if file.starts_with("dist/") {
            format!("The Resolve plugin's {file} isn't built yet. Run npm run build:panel, then install again.")
        } else {
            format!("The Resolve plugin is incomplete: {} is missing from {}", file, source.display())
        });
    }
    std::fs::create_dir_all(root).map_err(|e| format!("Couldn't create {}: {e}", root.display()))?;
    let target = root.join(BUNDLE_ID);
    let staging = root.join(format!(".{BUNDLE_ID}.installing"));
    remove(&staging)?;
    for file in PLUGIN_FILES {
        let to = staging.join(file);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        std::fs::copy(source.join(file), &to).map_err(|e| format!("Couldn't copy {file}: {e}"))?;
    }
    remove(&target)?;
    std::fs::rename(&staging, &target).map_err(|e| format!("Couldn't install the plugin: {e}"))?;
    Ok(target)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePluginStatus {
    pub resolve_installed: bool,
    /// The plugin the app would install.
    pub bundled_version: Option<String>,
    /// The copy in Resolve's plugin folder, if any.
    pub installed_version: Option<String>,
    pub installed_path: String,
    /// Whether the window is open in Resolve now (its heartbeat in `chat/resolve/` is fresh).
    pub running: bool,
}

fn status(source: &Path) -> Result<ResolvePluginStatus, String> {
    let target = plugins_root().join(BUNDLE_ID);
    Ok(ResolvePluginStatus {
        resolve_installed: Path::new(RESOLVE_APP).is_dir(),
        bundled_version: plugin_version(source),
        installed_version: plugin_version(&target),
        installed_path: target.to_string_lossy().into_owned(),
        running: crate::broll_panel::panel_attached(&crate::host_chat::host_dir(Host::Resolve)?),
    })
}

#[tauri::command]
pub async fn resolve_plugin_status(app: AppHandle) -> Result<ResolvePluginStatus, String> {
    let source = plugin_source(&app);
    tauri::async_runtime::spawn_blocking(move || status(&source)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_plugin_install(app: AppHandle) -> Result<ResolvePluginStatus, String> {
    let source = plugin_source(&app);
    tauri::async_runtime::spawn_blocking(move || {
        install_into(&source, &plugins_root())?;
        status(&source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_plugin_uninstall(app: AppHandle) -> Result<ResolvePluginStatus, String> {
    let source = plugin_source(&app);
    tauri::async_runtime::spawn_blocking(move || {
        remove(&plugins_root().join(BUNDLE_ID))?;
        status(&source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-resolve-plugin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_plugin(dir: &Path, version: &str) {
        for file in PLUGIN_FILES {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, version).unwrap();
        }
        std::fs::write(dir.join("manifest.xml"), format!("<BlackmagicDesign><Plugin><Version> {version} </Version></Plugin></BlackmagicDesign>")).unwrap();
    }

    #[test]
    fn install_copies_only_the_plugin_and_replaces_an_older_copy() {
        let dir = scratch("install");
        let (source, root) = (dir.join("src"), dir.join("Workflow Integration Plugins"));
        fake_plugin(&source, "0.19.0");
        std::fs::write(source.join("notes.txt"), "not shipped").unwrap();
        let old = root.join(BUNDLE_ID);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("stale.js"), "old").unwrap();
        let vibecut = root.join("com.vibecut.agent");
        std::fs::create_dir_all(&vibecut).unwrap();

        let target = install_into(&source, &root).unwrap();
        assert_eq!(target, old);
        assert_eq!(plugin_version(&target).as_deref(), Some("0.19.0"));
        assert!(target.join("dist/panel.js").is_file());
        assert!(!target.join("notes.txt").exists() && !target.join("stale.js").exists());
        assert!(vibecut.is_dir(), "VibeCut's own plugin is left alone");
        assert!(!root.join(format!(".{BUNDLE_ID}.installing")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unbuilt_or_incomplete_plugin_is_refused_and_nothing_changes() {
        let dir = scratch("incomplete");
        let (source, root) = (dir.join("src"), dir.join("root"));
        fake_plugin(&source, "0.19.0");
        std::fs::remove_file(source.join("dist/panel.js")).unwrap();
        assert!(install_into(&source, &root).unwrap_err().contains("npm run build:panel"));
        std::fs::remove_file(source.join("preload.js")).unwrap();
        assert!(install_into(&source, &root).unwrap_err().contains("preload.js is missing"));
        assert!(!root.join(BUNDLE_ID).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_repositorys_plugin_is_complete_versioned_and_not_vibecuts() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-resolve-plugin");
        for file in PLUGIN_FILES.iter().filter(|f| !f.starts_with("dist/")) {
            assert!(repo.join(file).is_file(), "{file} is missing from src-resolve-plugin");
        }
        assert_eq!(plugin_version(&repo).as_deref(), Some("0.20.1"));
        let manifest = std::fs::read_to_string(repo.join("manifest.xml")).unwrap();
        assert!(manifest.contains("<Id>com.vibecutagent.resolve</Id>") && !manifest.contains("com.vibecut.agent"));
        let package = std::fs::read_to_string(repo.join("package.json")).unwrap();
        assert!(package.contains("\"version\": \"0.20.1\""));
        let files = std::fs::read_to_string(repo.join("files.js")).unwrap();
        assert!(files.contains(r#""VibeCut Agent", "host-bridge", "chat", "resolve""#));
    }
}
