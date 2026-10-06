//! The API keys (AGENTS.md §4): the LLM keys, and the Hugging Face token that speaker labels need
//! (Phase 6b). Where they come from, and storing them in the macOS Keychain.
//!
//! A key is looked up in this order:
//! 1. The environment of the process. In dev builds that includes the repository's `.env`, which
//!    `run()` loads with dotenvy.
//! 2. The login Keychain: an item under service `com.cj.vibecutagent`, named after the variable
//!    (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `HF_TOKEN`), which Settings saves.
//!
//! A release build opened from Finder has no shell environment and no `.env`, so the Keychain is
//! how it gets keys. Values never leave Rust except inside a sidecar's stdin request (a chat's LLM key,
//! a speaker-labelling transcription's HF token: `sidecar::sidecar_start`); nothing here logs or returns one.

use crate::sidecar::{CLAUDE_KEY_ENV, GEMINI_KEY_ENV};
use serde::{Deserialize, Serialize};
use tauri::State;

pub const KEYCHAIN_SERVICE: &str = "com.cj.vibecutagent";
/// Longer than any provider's keys; anything past it is a paste gone wrong.
const MAX_KEY_LEN: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gemini,
    Anthropic,
    /// Hugging Face: pyannote's speaker-diarization models (transcription with speaker labels).
    Huggingface,
}

pub const HF_TOKEN_ENV: &str = "HF_TOKEN";

impl Provider {
    pub fn env(self) -> &'static str {
        match self {
            Provider::Gemini => GEMINI_KEY_ENV,
            Provider::Anthropic => CLAUDE_KEY_ENV,
            Provider::Huggingface => HF_TOKEN_ENV,
        }
    }
}

/// Where a key was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Environment,
    Keychain,
}

/// Secret storage, so tests never touch the real Keychain.
pub trait KeyStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Removes the item; missing is fine.
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// The macOS login Keychain, through the `keyring` crate.
pub struct Keychain;

impl Keychain {
    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| format!("Couldn't open the Keychain: {e}"))
    }
}

impl KeyStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match Keychain::entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read {name} from the Keychain: {e}")),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        Keychain::entry(name)?.set_password(value).map_err(|e| format!("Couldn't save {name} in the Keychain: {e}"))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match Keychain::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Couldn't remove {name} from the Keychain: {e}")),
        }
    }
}

/// The shared store, managed by Tauri.
pub struct Keys(pub Box<dyn KeyStore>);

fn present(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The key named `env` and where it came from: the environment first, then the store. A store that
/// can't be read counts as not having the key.
pub fn resolve(env: &str, store: &dyn KeyStore) -> Option<(String, KeySource)> {
    if let Some(value) = present(std::env::var(env).ok()) {
        return Some((value, KeySource::Environment));
    }
    present(store.get(env).ok().flatten()).map(|value| (value, KeySource::Keychain))
}

/// A pasted key, cleaned up, or why it can't be one. Never echoes the value back.
pub fn checked_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("The key is empty".into());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("That's longer than an API key ({} characters at most)", MAX_KEY_LEN));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An API key is one word, with no spaces or line breaks".into());
    }
    Ok(key.to_string())
}

/// Whether each provider's key is set, and where. Never a key itself.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub gemini: bool,
    pub anthropic: bool,
    pub gemini_source: Option<KeySource>,
    pub anthropic_source: Option<KeySource>,
    pub huggingface: bool,
    pub huggingface_source: Option<KeySource>,
}

pub fn status(store: &dyn KeyStore) -> KeyStatus {
    let gemini = resolve(GEMINI_KEY_ENV, store).map(|(_, source)| source);
    let anthropic = resolve(CLAUDE_KEY_ENV, store).map(|(_, source)| source);
    let huggingface = resolve(HF_TOKEN_ENV, store).map(|(_, source)| source);
    KeyStatus {
        gemini: gemini.is_some(),
        anthropic: anthropic.is_some(),
        gemini_source: gemini,
        anthropic_source: anthropic,
        huggingface: huggingface.is_some(),
        huggingface_source: huggingface,
    }
}

#[tauri::command]
pub fn llm_key_status(keys: State<'_, Keys>) -> KeyStatus {
    status(keys.0.as_ref())
}

/// Saves a provider's key in the Keychain. A key set in the environment still takes precedence.
#[tauri::command]
pub fn llm_key_set(keys: State<'_, Keys>, provider: Provider, key: String) -> Result<KeyStatus, String> {
    let key = checked_key(&key)?;
    keys.0.set(provider.env(), &key)?;
    Ok(status(keys.0.as_ref()))
}

#[tauri::command]
pub fn llm_key_remove(keys: State<'_, Keys>, provider: Provider) -> Result<KeyStatus, String> {
    keys.0.delete(provider.env())?;
    Ok(status(keys.0.as_ref()))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// An in-memory KeyStore.
    #[derive(Default)]
    pub struct Memory(pub Mutex<HashMap<String, String>>);

    impl KeyStore for Memory {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    struct Broken;

    impl KeyStore for Broken {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Err("locked".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
    }

    // Each test uses its own variable name, so tests running in parallel never share the environment.
    #[test]
    fn the_environment_wins_over_the_keychain() {
        let store = Memory::default();
        let env = "VCA_TEST_KEY_PRECEDENCE";
        assert_eq!(resolve(env, &store), None);
        store.set(env, " from-keychain ").unwrap();
        assert_eq!(resolve(env, &store), Some(("from-keychain".into(), KeySource::Keychain)));
        std::env::set_var(env, "from-env");
        assert_eq!(resolve(env, &store), Some(("from-env".into(), KeySource::Environment)));
        std::env::set_var(env, "   ");
        assert_eq!(resolve(env, &store).map(|(_, s)| s), Some(KeySource::Keychain), "a blank variable doesn't count");
        std::env::remove_var(env);
    }

    #[test]
    fn an_unreadable_keychain_reads_as_no_key() {
        assert_eq!(resolve("VCA_TEST_KEY_BROKEN", &Broken), None);
    }

    #[test]
    fn pasted_keys_are_cleaned_and_checked_without_echoing_them() {
        assert_eq!(checked_key("  AIza-abc_123 \n").unwrap(), "AIza-abc_123");
        assert_eq!(checked_key("   ").unwrap_err(), "The key is empty");
        let spaced = checked_key("two words").unwrap_err();
        assert!(spaced.contains("one word") && !spaced.contains("two"));
        assert!(checked_key(&"k".repeat(600)).unwrap_err().contains("longer than an API key"));
    }

    #[test]
    fn status_says_where_each_key_came_from() {
        let store = Memory::default();
        let before = status(&store);
        store.set(GEMINI_KEY_ENV, "g").unwrap();
        let after = status(&store);
        // The real environment may hold keys while testing, so only what the store changed is checked.
        if before.gemini_source.is_none() {
            assert_eq!(after.gemini_source, Some(KeySource::Keychain));
            assert!(after.gemini);
        }
        let wire = serde_json::to_value(&after).unwrap();
        assert!(wire.get("geminiSource").is_some() && wire.get("anthropicSource").is_some());
        assert!(!wire.to_string().contains("\"g\""), "a status never carries a key");
    }

    /// The real login Keychain, under a throwaway service so no real key is touched. Opt-in, since it
    /// writes to the user's Keychain: `cargo test -- --ignored real_keychain`.
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        let entry = keyring::Entry::new("com.cj.vibecutagent.selftest", "SELFTEST_KEY").unwrap();
        entry.set_password("not-a-real-key").unwrap();
        assert_eq!(entry.get_password().unwrap(), "not-a-real-key");
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn providers_name_their_variables() {
        assert_eq!(Provider::Gemini.env(), "GEMINI_API_KEY");
        assert_eq!(Provider::Anthropic.env(), "ANTHROPIC_API_KEY");
        assert_eq!(serde_json::from_str::<Provider>("\"anthropic\"").unwrap(), Provider::Anthropic);
        assert_eq!(Provider::Huggingface.env(), "HF_TOKEN");
        assert_eq!(serde_json::from_str::<Provider>("\"huggingface\"").unwrap(), Provider::Huggingface);
    }
}
