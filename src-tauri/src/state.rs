//! Shared Rust-side state. The tray can show the window before the webview has attached its
//! `navigate` listener (first open after launch), so the requested view is also parked here and the
//! frontend collects it with `take_pending_view` on mount.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// A screen the tray can open. Serialized lowercase to match `View` in `src/types/system.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Chat,
    Library,
    /// The B-roll analyzer (the Analyze tab).
    Broll,
    Settings,
    About,
}

#[derive(Default)]
pub struct AppState {
    pub pending_view: Mutex<Option<View>>,
}

impl AppState {
    pub fn set_pending_view(&self, view: View) {
        if let Ok(mut pending) = self.pending_view.lock() {
            *pending = Some(view);
        }
    }

    pub fn take_pending_view(&self) -> Option<View> {
        self.pending_view.lock().ok().and_then(|mut pending| pending.take())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_view_is_taken_once() {
        let state = AppState::default();
        assert_eq!(state.take_pending_view(), None);
        state.set_pending_view(View::Broll);
        state.set_pending_view(View::About);
        assert_eq!(state.take_pending_view(), Some(View::About));
        assert_eq!(state.take_pending_view(), None);
    }

    #[test]
    fn views_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&View::Broll).unwrap(), "\"broll\"");
        assert_eq!(serde_json::to_string(&View::Library).unwrap(), "\"library\"");
        assert_eq!(serde_json::from_str::<View>("\"settings\"").unwrap(), View::Settings);
    }
}
