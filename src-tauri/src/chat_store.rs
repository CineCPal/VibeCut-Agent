//! Past chats and the edit log, kept across restarts (PLAN.md, Phase 8a). The webview owns their shape;
//! Rust only files them, as local JSON in the app's data folder (AGENTS.md §4), never in localStorage:
//! a provider's history carries tool results and can run to megabytes.
//!
//! ```text
//! <app data>/history/          0700 (VIBECUT_AGENT_HISTORY_DIR overrides it, for tests and dev builds)
//!   index.json                 [{ id, title, createdAt, updatedAt, messageCount }], newest first
//!   edit-log.json              { version, entries, backups, restoredIds } (useEditLogStore)
//!   chats/<id>.json            { version, id, title, customTitle?, autoTitle?, createdAt, updatedAt, provider,
//!                                aiChoice, messages, history, rewind? }
//! ```
//!
//! Phase 8d: `chat_rename` names a chat without opening it (the user's name, `customTitle`, wins over the
//! model's, `autoTitle`, which wins over the first request), and `chat_search` finds chats by what was said.
//!
//! Every file is written atomically and is at most `MAX_FILE_BYTES`. Only the newest `KEEP_CHATS` chats
//! are kept. A corrupt chat is left out of the list, never fatal; a missing or corrupt index is rebuilt
//! from the chats.

use crate::broll_panel::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
pub const KEEP_CHATS: usize = 30;
const INDEX: &str = "index.json";
const EDIT_LOG: &str = "edit-log.json";
const CHATS: &str = "chats";
const TITLE_CHARS: usize = 120;
/** A name given to a chat (by the user or the model), and the first-request fallback (chatHistory.ts). */
const NAME_CHARS: usize = 60;
const FIRST_REQUEST_CHARS: usize = 60;
const QUERY_CHARS: usize = 100;
const SNIPPET_BEFORE: usize = 30;
const SNIPPET_AFTER: usize = 70;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    /// The words around the first match, on one line.
    pub snippet: String,
    /// Where the match is in `snippet`, in characters.
    pub match_start: usize,
    pub match_end: usize,
}

/// One save, list or delete at a time, so the index never loses a chat to a race.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub message_count: usize,
}

/// The folder. `VIBECUT_AGENT_HISTORY_DIR` overrides it.
pub fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("VIBECUT_AGENT_HISTORY_DIR") {
        return Ok(PathBuf::from(custom));
    }
    app.path().app_data_dir().map(|d| d.join("history")).map_err(|_| "The app's data folder is unavailable".to_string())
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn checked_id(id: &str) -> Result<(), String> {
    if valid_id(id) { Ok(()) } else { Err("That chat id isn't valid".into()) }
}

/// Makes `dir` (and its parents) private to the user.
fn ensure_private(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_json(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{name} would be {:.1} MB, over the {} MB limit",
            bytes.len() as f64 / 1_048_576.0,
            MAX_FILE_BYTES / 1_048_576
        ));
    }
    write_atomic(dir, name, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() as usize > MAX_FILE_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// What the list shows for a saved chat; None unless it's an object with this id.
pub fn summary_of(id: &str, chat: &Value) -> Option<ChatSummary> {
    let obj = chat.as_object()?;
    if obj.get("id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    let num = |key: &str| obj.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let title: String = obj.get("title").and_then(Value::as_str).unwrap_or("").chars().take(TITLE_CHARS).collect();
    Some(ChatSummary {
        id: id.to_string(),
        title: if title.trim().is_empty() { "Untitled chat".into() } else { title },
        created_at: num("createdAt"),
        updated_at: num("updatedAt"),
        message_count: obj.get("messages").and_then(Value::as_array).map_or(0, Vec::len),
    })
}

fn newest_first(list: &mut [ChatSummary]) {
    list.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
}

/// The index from the chats themselves (when it's missing or unreadable).
fn rebuild_index(dir: &Path) -> Vec<ChatSummary> {
    let Ok(read) = std::fs::read_dir(dir.join(CHATS)) else { return Vec::new() };
    let mut list: Vec<ChatSummary> = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?.to_string();
            if !valid_id(&id) {
                return None;
            }
            summary_of(&id, &read_json(&entry.path())?)
        })
        .collect();
    newest_first(&mut list);
    list
}

fn read_index(dir: &Path) -> Vec<ChatSummary> {
    let saved = read_json(&dir.join(INDEX)).and_then(|v| serde_json::from_value::<Vec<ChatSummary>>(v).ok());
    match saved {
        // Only chats whose file is still there.
        Some(list) => list.into_iter().filter(|s| valid_id(&s.id) && dir.join(CHATS).join(format!("{}.json", s.id)).is_file()).collect(),
        None => rebuild_index(dir),
    }
}

fn write_index(dir: &Path, list: &[ChatSummary]) -> Result<(), String> {
    write_json(dir, INDEX, &serde_json::to_value(list).map_err(|e| e.to_string())?)
}

pub fn list_in(dir: &Path) -> Vec<ChatSummary> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    read_index(dir)
}

pub fn load_in(dir: &Path, id: &str) -> Result<Value, String> {
    checked_id(id)?;
    read_json(&dir.join(CHATS).join(format!("{id}.json"))).ok_or_else(|| "That chat is gone or can't be read".to_string())
}

/// Saves a chat, files it newest first, and deletes chats past `KEEP_CHATS`.
pub fn save_in(dir: &Path, id: &str, chat: &Value) -> Result<Vec<ChatSummary>, String> {
    checked_id(id)?;
    let summary = summary_of(id, chat).ok_or("A chat must be an object with its own id")?;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    ensure_private(dir)?;
    let chats = dir.join(CHATS);
    ensure_private(&chats)?;
    write_json(&chats, &format!("{id}.json"), chat)?;
    let mut list: Vec<ChatSummary> = read_index(dir).into_iter().filter(|s| s.id != id).collect();
    list.push(summary);
    newest_first(&mut list);
    for old in list.split_off(KEEP_CHATS.min(list.len())) {
        let _ = std::fs::remove_file(chats.join(format!("{}.json", old.id)));
    }
    write_index(dir, &list)?;
    Ok(list)
}

pub fn delete_in(dir: &Path, id: &str) -> Result<Vec<ChatSummary>, String> {
    checked_id(id)?;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let _ = std::fs::remove_file(dir.join(CHATS).join(format!("{id}.json")));
    let list: Vec<ChatSummary> = read_index(dir).into_iter().filter(|s| s.id != id).collect();
    if dir.is_dir() {
        write_index(dir, &list)?;
    }
    Ok(list)
}

/// Text on one line: runs of whitespace become one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

/// The list's fallback name: the first request, as chatHistory.ts's `chatTitle` makes it.
fn first_request(chat: &Value) -> String {
    let first = chat["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "user"))
        .and_then(|m| m["text"].as_str())
        .unwrap_or("");
    cut(&one_line(first), FIRST_REQUEST_CHARS)
}

/// Names a saved chat. `auto`: the model's name, kept as `autoTitle` and shown unless the user named it.
/// Otherwise the user's (`customTitle`); a blank one goes back to the model's name or the first request.
/// The chat keeps its place in the list. Answers the list.
pub fn rename_in(dir: &Path, id: &str, title: &str, auto: bool) -> Result<Vec<ChatSummary>, String> {
    checked_id(id)?;
    let name = cut(&one_line(title), NAME_CHARS);
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let chats = dir.join(CHATS);
    let mut chat = read_json(&chats.join(format!("{id}.json"))).ok_or("That chat is gone or can't be read")?;
    let obj = chat.as_object_mut().ok_or("That chat can't be read")?;
    if auto {
        if name.is_empty() {
            return Ok(read_index(dir));
        }
        obj.insert("autoTitle".into(), Value::String(name));
    } else if name.is_empty() {
        obj.remove("customTitle");
    } else {
        obj.insert("customTitle".into(), Value::String(name));
    }
    let shown = ["customTitle", "autoTitle"]
        .iter()
        .find_map(|key| obj.get(*key).and_then(Value::as_str).filter(|t| !t.trim().is_empty()).map(str::to_string));
    let shown = shown.unwrap_or_else(|| first_request(&chat));
    chat["title"] = Value::String(shown);
    let summary = summary_of(id, &chat).ok_or("That chat can't be read")?;
    write_json(&chats, &format!("{id}.json"), &chat)?;
    let list: Vec<ChatSummary> = read_index(dir).into_iter().map(|s| if s.id == id { summary.clone() } else { s }).collect();
    write_index(dir, &list)?;
    Ok(list)
}

/// Where `needle` (already lowercase) first occurs in `haystack`, ignoring case: (start, end) in chars.
fn find_ignoring_case(haystack: &[char], needle: &[char]) -> Option<(usize, usize)> {
    let lower: Vec<char> = haystack.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    if needle.is_empty() || needle.len() > lower.len() {
        return None;
    }
    (0..=lower.len() - needle.len()).find(|&i| lower[i..i + needle.len()] == *needle).map(|i| (i, i + needle.len()))
}

fn hit_in(id: &str, text: &str, needle: &[char]) -> Option<SearchHit> {
    let chars: Vec<char> = one_line(text).chars().collect();
    let (start, end) = find_ignoring_case(&chars, needle)?;
    let from = start.saturating_sub(SNIPPET_BEFORE);
    let to = (end + SNIPPET_AFTER).min(chars.len());
    let lead = if from > 0 { "…" } else { "" };
    let tail = if to < chars.len() { "…" } else { "" };
    let lead_chars = lead.chars().count();
    Some(SearchHit {
        id: id.to_string(),
        snippet: format!("{lead}{}{tail}", chars[from..to].iter().collect::<String>()),
        match_start: start - from + lead_chars,
        match_end: end - from + lead_chars,
    })
}

/// The saved chats whose name or messages (what the user and the agent said, never the model's history)
/// contain `query`, ignoring case, newest first, each with the words around its first match.
pub fn search_in(dir: &Path, query: &str) -> Vec<SearchHit> {
    let needle: Vec<char> = one_line(query).chars().take(QUERY_CHARS).flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    read_index(dir)
        .into_iter()
        .filter_map(|summary| {
            let chat = read_json(&dir.join(CHATS).join(format!("{}.json", summary.id)))?;
            let said = chat["messages"].as_array()?.iter().filter(|m| m["role"] == "user" || m["role"] == "assistant");
            std::iter::once(summary.title.as_str())
                .chain(said.filter_map(|m| m["text"].as_str()))
                .find_map(|text| hit_in(&summary.id, text, &needle))
        })
        .collect()
}

pub fn load_edit_log_in(dir: &Path) -> Option<Value> {
    read_json(&dir.join(EDIT_LOG)).filter(Value::is_object)
}

pub fn save_edit_log_in(dir: &Path, log: &Value) -> Result<(), String> {
    if !log.is_object() {
        return Err("The edit log must be an object".into());
    }
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    ensure_private(dir)?;
    write_json(dir, EDIT_LOG, log)
}

#[tauri::command]
pub async fn chat_list(app: AppHandle) -> Result<Vec<ChatSummary>, String> {
    Ok(list_in(&history_dir(&app)?))
}

#[tauri::command]
pub async fn chat_load(app: AppHandle, id: String) -> Result<Value, String> {
    load_in(&history_dir(&app)?, &id)
}

#[tauri::command]
pub async fn chat_save(app: AppHandle, id: String, chat: Value) -> Result<Vec<ChatSummary>, String> {
    save_in(&history_dir(&app)?, &id, &chat)
}

#[tauri::command]
pub async fn chat_delete(app: AppHandle, id: String) -> Result<Vec<ChatSummary>, String> {
    delete_in(&history_dir(&app)?, &id)
}

#[tauri::command]
pub async fn chat_rename(app: AppHandle, id: String, title: String, auto: Option<bool>) -> Result<Vec<ChatSummary>, String> {
    rename_in(&history_dir(&app)?, &id, &title, auto.unwrap_or(false))
}

#[tauri::command]
pub async fn chat_search(app: AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    Ok(search_in(&history_dir(&app)?, &query))
}

#[tauri::command]
pub async fn edit_log_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load_edit_log_in(&history_dir(&app)?))
}

#[tauri::command]
pub async fn edit_log_save(app: AppHandle, log: Value) -> Result<(), String> {
    save_edit_log_in(&history_dir(&app)?, &log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vca-chat-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn chat(id: &str, updated: f64) -> Value {
        json!({ "version": 1, "id": id, "title": format!("Chat {id}"), "createdAt": 1.0, "updatedAt": updated,
                "messages": [{ "role": "user", "text": "hi" }, { "role": "assistant", "text": "hello" }], "history": [] })
    }

    #[test]
    fn ids_are_checked() {
        assert!(valid_id("abc-123_X"));
        for bad in ["", "../x", "a/b", "a.b", "a b", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
        let dir = temp_dir("ids");
        assert!(save_in(&dir, "../evil", &chat("../evil", 1.0)).is_err());
        assert!(load_in(&dir, "a.b").is_err());
        assert!(delete_in(&dir, "a/b").is_err());
    }

    #[test]
    fn saves_round_trip_and_list_newest_first() {
        let dir = temp_dir("order");
        save_in(&dir, "a", &chat("a", 10.0)).unwrap();
        save_in(&dir, "b", &chat("b", 30.0)).unwrap();
        let list = save_in(&dir, "c", &chat("c", 20.0)).unwrap();
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
        assert_eq!(list[0].message_count, 2);
        assert_eq!(list[0].title, "Chat b");
        // Saving again moves it up, once.
        let list = save_in(&dir, "a", &chat("a", 40.0)).unwrap();
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(load_in(&dir, "b").unwrap(), chat("b", 30.0));
        assert_eq!(list_in(&dir), list);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chat_must_carry_its_own_id() {
        let dir = temp_dir("own-id");
        assert!(save_in(&dir, "a", &chat("b", 1.0)).is_err());
        assert!(save_in(&dir, "a", &json!([1, 2])).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untitled_and_long_titles() {
        let mut c = chat("t", 1.0);
        c["title"] = json!("  ");
        assert_eq!(summary_of("t", &c).unwrap().title, "Untitled chat");
        c["title"] = json!("é".repeat(300));
        assert_eq!(summary_of("t", &c).unwrap().title.chars().count(), TITLE_CHARS);
    }

    #[test]
    fn only_the_newest_chats_are_kept() {
        let dir = temp_dir("keep");
        for i in 0..(KEEP_CHATS + 3) {
            save_in(&dir, &format!("c{i}"), &chat(&format!("c{i}"), i as f64)).unwrap();
        }
        let list = list_in(&dir);
        assert_eq!(list.len(), KEEP_CHATS);
        assert_eq!(list.last().unwrap().id, "c3");
        assert!(!dir.join("chats/c0.json").exists());
        assert!(!dir.join("chats/c2.json").exists());
        assert!(dir.join("chats/c3.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_chats_are_refused() {
        let dir = temp_dir("size");
        let mut c = chat("big", 1.0);
        c["history"] = json!(["x".repeat(MAX_FILE_BYTES)]);
        let error = save_in(&dir, "big", &c).unwrap_err();
        assert!(error.contains("over the 16 MB limit"), "{error}");
        assert!(list_in(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_chat_is_skipped_and_a_lost_index_is_rebuilt() {
        let dir = temp_dir("corrupt");
        save_in(&dir, "good", &chat("good", 5.0)).unwrap();
        save_in(&dir, "bad", &chat("bad", 6.0)).unwrap();
        std::fs::write(dir.join("chats/bad.json"), b"{not json").unwrap();
        std::fs::write(dir.join(INDEX), b"garbage").unwrap();
        let list = list_in(&dir);
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["good"]);
        assert!(load_in(&dir, "bad").is_err());
        // A file deleted behind the index's back drops out of it.
        save_in(&dir, "other", &chat("other", 7.0)).unwrap();
        std::fs::remove_file(dir.join("chats/other.json")).unwrap();
        assert_eq!(list_in(&dir).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["good"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_the_file_and_its_row() {
        let dir = temp_dir("delete");
        save_in(&dir, "a", &chat("a", 1.0)).unwrap();
        save_in(&dir, "b", &chat("b", 2.0)).unwrap();
        let list = delete_in(&dir, "a").unwrap();
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(!dir.join("chats/a.json").exists());
        assert!(delete_in(&temp_dir("delete-none"), "a").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_edit_log_round_trips() {
        let dir = temp_dir("edit-log");
        assert_eq!(load_edit_log_in(&dir), None);
        assert!(save_edit_log_in(&dir, &json!([1])).is_err());
        let log = json!({ "version": 1, "entries": [{ "id": "e1" }], "backups": {}, "restoredIds": { "premiere": {}, "resolve": {} } });
        save_edit_log_in(&dir, &log).unwrap();
        assert_eq!(load_edit_log_in(&dir), Some(log));
        std::fs::write(dir.join(EDIT_LOG), b"[]").unwrap();
        assert_eq!(load_edit_log_in(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_a_chat_that_isnt_open_keeps_its_place() {
        let dir = temp_dir("rename");
        save_in(&dir, "a", &chat("a", 1.0)).unwrap();
        save_in(&dir, "b", &chat("b", 2.0)).unwrap();
        let list = rename_in(&dir, "a", "  Bakery\n  rough cut ", false).unwrap();
        assert_eq!(list.iter().map(|s| (s.id.as_str(), s.title.as_str())).collect::<Vec<_>>(), [("b", "Chat b"), ("a", "Bakery rough cut")]);
        let saved = load_in(&dir, "a").unwrap();
        assert_eq!(saved["customTitle"], "Bakery rough cut");
        assert_eq!(saved["updatedAt"], 1.0, "a rename isn't a change to the conversation");
        assert_eq!(list_in(&dir), list);
        assert!(rename_in(&dir, "gone", "x", false).is_err());
        assert!(rename_in(&dir, "../a", "x", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_users_name_wins_over_the_models_and_blank_goes_back() {
        let dir = temp_dir("rename-order");
        save_in(&dir, "a", &chat("a", 1.0)).unwrap();
        assert_eq!(rename_in(&dir, "a", "Model name", true).unwrap()[0].title, "Model name");
        assert_eq!(rename_in(&dir, "a", "Mine", false).unwrap()[0].title, "Mine");
        assert_eq!(rename_in(&dir, "a", "Newer model name", true).unwrap()[0].title, "Mine");
        assert_eq!(rename_in(&dir, "a", "   ", false).unwrap()[0].title, "Newer model name");
        let saved = load_in(&dir, "a").unwrap();
        assert!(saved.get("customTitle").is_none());
        let mut plain = chat("p", 2.0);
        plain["messages"][0]["text"] = json!(format!("trim   the {}", "intro ".repeat(20)));
        save_in(&dir, "p", &plain).unwrap();
        rename_in(&dir, "p", "Named", false).unwrap();
        let title = rename_in(&dir, "p", "", false).unwrap()[0].title.clone();
        assert!(title.starts_with("trim the intro"), "{title}");
        assert_eq!(title.chars().count(), FIRST_REQUEST_CHARS);
        assert_eq!(rename_in(&dir, "p", &"x".repeat(300), false).unwrap()[0].title.chars().count(), NAME_CHARS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_finds_what_was_said_ignoring_case_but_never_the_history() {
        let dir = temp_dir("search");
        let mut a = chat("a", 1.0);
        a["messages"] = json!([
            { "role": "user", "text": "Good morning, I have a long request today. Put a marker on every INTERVIEW clip, please, and then tell me which ones are the longest, so I can trim them before the client review this afternoon" },
            { "role": "tool", "text": "interview tool line" },
        ]);
        a["history"] = json!(["secret-in-history"]);
        save_in(&dir, "a", &a).unwrap();
        save_in(&dir, "b", &chat("b", 2.0)).unwrap();
        save_in(&dir, "bad", &chat("bad", 3.0)).unwrap();
        std::fs::write(dir.join("chats/bad.json"), b"{not json").unwrap();

        let hits = search_in(&dir, "interview");
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!(hit.id, "a");
        let shown: String = hit.snippet.chars().skip(hit.match_start).take(hit.match_end - hit.match_start).collect();
        assert_eq!(shown, "INTERVIEW");
        assert!(hit.snippet.starts_with('…') && hit.snippet.ends_with('…'), "{}", hit.snippet);
        assert!(search_in(&dir, "secret-in-history").is_empty());
        assert!(search_in(&dir, "tool line").is_empty(), "tool lines aren't what was said");
        assert_eq!(search_in(&dir, "chat B")[0].id, "b", "the name counts too");
        assert_eq!(search_in(&dir, "HELLO").iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(search_in(&dir, "   ").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_handles_text_whose_case_changes_its_length() {
        let chars: Vec<char> = "Straße İstanbul".chars().collect();
        // "İ" lowercases to two characters; each is matched by its first, so offsets stay in the original's.
        let needle: Vec<char> = "istanbul".chars().collect();
        assert_eq!(find_ignoring_case(&chars, &needle), Some((7, 15)));
        let needle: Vec<char> = "straße".chars().collect();
        assert_eq!(find_ignoring_case(&chars, &needle), Some((0, 6)));
    }

    #[cfg(unix)]
    #[test]
    fn folders_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        save_in(&dir, "a", &chat("a", 1.0)).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("chats")), 0o700);
        assert_eq!(mode(&dir.join("chats/a.json")), 0o600);
        assert_eq!(mode(&dir.join(INDEX)), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
