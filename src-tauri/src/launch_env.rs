//! The installed app's launch environment, however it's started.
//!
//! `npm run install-app -- --orchestrated` writes EXECUTION_MODE, VIBECUT_TELEMETRY and the model
//! variables into the bundle's Info.plist `LSEnvironment`. LaunchServices applies that dict only when it
//! opens the app (Dock, Spotlight, Finder). "Open at login" is a LaunchAgent (login_item.rs) that runs
//! `Contents/MacOS/vibecut-agent` straight from launchd, which never reads `LSEnvironment`, so an app
//! started at login ran in direct mode with telemetry off, and the Telemetry Studio saw nothing.
//!
//! `apply()` runs first thing in `run()`, before any thread or sidecar exists. It reads the bundle's own
//! Info.plist and sets each `LSEnvironment` value that isn't already set, so a value from the real
//! environment (a terminal, `tauri dev`) still wins. A dev build has no bundle, so it does nothing there.

use std::path::{Path, PathBuf};

/// `Contents/Info.plist` of the bundle `exe` runs from (`<App>.app/Contents/MacOS/<exe>`), if it is one.
fn bundle_info_plist(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    let plist = contents.join("Info.plist");
    plist.is_file().then_some(plist)
}

/// The `LSEnvironment` string pairs of an Info.plist; empty when it has none or can't be read.
fn ls_environment(info_plist: &Path) -> Vec<(String, String)> {
    let Ok(value) = plist::Value::from_file(info_plist) else {
        return Vec::new();
    };
    let Some(env) = value
        .as_dictionary()
        .and_then(|d| d.get("LSEnvironment"))
        .and_then(|v| v.as_dictionary())
    else {
        return Vec::new();
    };
    env.iter()
        .filter_map(|(k, v)| v.as_string().map(|s| (k.clone(), s.to_string())))
        .collect()
}

/// The pairs to set: those whose name isn't already in the environment.
fn missing<'a>(
    pairs: &'a [(String, String)],
    is_set: impl Fn(&str) -> bool,
) -> impl Iterator<Item = &'a (String, String)> {
    pairs.iter().filter(move |(k, _)| !k.is_empty() && !is_set(k))
}

/// Sets the bundle's `LSEnvironment` values that the launch didn't. Call before spawning any thread.
pub fn apply() {
    let Some(plist) = std::env::current_exe().ok().and_then(|exe| bundle_info_plist(&exe)) else {
        return;
    };
    let pairs = ls_environment(&plist);
    for (key, value) in missing(&pairs, |k| std::env::var_os(k).is_some()) {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_bundle(name: &str, info_plist: Option<&str>) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vibecut-launch-env-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let macos = root.join("Test.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        if let Some(xml) = info_plist {
            std::fs::write(root.join("Test.app/Contents/Info.plist"), xml).unwrap();
        }
        let exe = macos.join("vibecut-agent");
        std::fs::write(&exe, b"").unwrap();
        exe
    }

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Test</string>
  <key>LSEnvironment</key><dict>
    <key>EXECUTION_MODE</key><string>orchestrated</string>
    <key>VIBECUT_TELEMETRY</key><string>1</string>
  </dict>
</dict></plist>"#;

    #[test]
    fn reads_the_bundles_ls_environment() {
        let exe = temp_bundle("reads", Some(PLIST));
        let plist = bundle_info_plist(&exe).expect("a bundle");
        let mut pairs = ls_environment(&plist);
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("EXECUTION_MODE".to_string(), "orchestrated".to_string()),
                ("VIBECUT_TELEMETRY".to_string(), "1".to_string()),
            ]
        );
    }

    #[test]
    fn a_binary_outside_a_bundle_has_none() {
        assert!(bundle_info_plist(Path::new("/repo/src-tauri/target/debug/vibecut-agent")).is_none());
        let exe = temp_bundle("no-plist", None);
        assert!(bundle_info_plist(&exe).is_none());
    }

    #[test]
    fn a_plist_without_ls_environment_gives_nothing() {
        let exe = temp_bundle("no-env", Some(r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>T</string></dict></plist>"#));
        assert!(ls_environment(&bundle_info_plist(&exe).unwrap()).is_empty());
    }

    #[test]
    fn the_real_environment_wins() {
        let pairs = vec![
            ("EXECUTION_MODE".to_string(), "orchestrated".to_string()),
            ("VIBECUT_TELEMETRY".to_string(), "1".to_string()),
        ];
        let set: Vec<_> = missing(&pairs, |k| k == "EXECUTION_MODE").map(|(k, _)| k.as_str()).collect();
        assert_eq!(set, vec!["VIBECUT_TELEMETRY"]);
    }
}
