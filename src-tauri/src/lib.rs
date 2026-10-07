mod audiosync;
mod broll_panel;
mod claude_code;
mod commands;
mod mcp_bridge;
#[cfg(target_os = "macos")]
mod native_drag;
mod nle;
mod premiere_panel;
mod secrets;
mod sidecar;
mod spyglass;
mod spyglass_archive;
mod state;
mod transcript;
mod tray;
mod window_mode;

use nle::Nle;
use secrets::{Keychain, Keys};
use sidecar::{AgentSession, SidecarJobs};
use state::AppState;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev builds read the LLM keys from the repository's `.env`; release builds from the Keychain (secrets.rs).
    // Values are never logged, never sent to the UI, and never passed to the sidecar's environment;
    // they reach it only inside a chat's stdin request.
    dotenvy::dotenv().ok();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The B-roll panel's folder picker (only `dialog:allow-open` is granted, capabilities/default.json).
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(SidecarJobs::default())
        .manage(AgentSession::default())
        .manage(Nle::default())
        .manage(Keys(Box::new(Keychain)))
        .manage(spyglass::ArchiveCache::default())
        .manage(audiosync::AudioSyncJobs::default())
        .manage(spyglass::DragCache::default())
        .manage(tray::KeepOnTopItem::default())
        .setup(|app| {
            // A menu-bar app: no Dock icon, and the window stays hidden until the tray opens it.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::setup(app)?;
            // Over full-screen Premiere / Resolve unless the user turned it off (window_mode.rs).
            window_mode::setup(app.handle());
            // Spawning only starts the process; the session reports `ready` on its own thread.
            sidecar::start_session(app.handle());
            // One watcher per editor; each reconnects on its own when its editor (re)starts.
            nle::start_all(app.handle());
            // The B-roll panel docked in Premiere (broll_panel.rs): its inbox and the app's heartbeat.
            broll_panel::start(app.handle());
            // The MCP bridge (mcp_bridge.rs): an MCP client calling the agent's tools, through files.
            mcp_bridge::start(app.handle());
            // Old waveform envelopes of the audio sync (audiosync.rs) are cleared out now and then.
            audiosync::prune_in_background(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides the window; the app keeps living in the menu bar until "Quit".
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == tray::MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::take_pending_view,
            secrets::llm_key_status,
            secrets::llm_key_set,
            secrets::llm_key_remove,
            commands::dependency_status,
            commands::hardware_acceleration,
            commands::storage_paths,
            sidecar::sidecar_start,
            sidecar::sidecar_send,
            sidecar::sidecar_cancel,
            sidecar::sidecar_session_status,
            sidecar::sidecar_session_restart,
            sidecar::sidecar_info,
            nle::nle_state,
            nle::nle_call,
            nle::nle_reconnect,
            premiere_panel::premiere_panel_status,
            premiere_panel::premiere_panel_install,
            premiere_panel::premiere_panel_uninstall,
            window_mode::keep_on_top_status,
            window_mode::set_keep_on_top,
            commands::media_durations,
            audiosync::sync_audio,
            audiosync::cancel_audio_sync,
            transcript::read_transcript,
            transcript::read_suite_sync,
            broll_panel::broll_panel_publish,
            broll_panel::broll_panel_status,
            mcp_bridge::mcp_reply,
            mcp_bridge::mcp_status,
            mcp_bridge::mcp_set_outside_allowed,
            mcp_bridge::mcp_client_setup,
            claude_code::claude_code_status,
            claude_code::claude_code_set,
            broll_panel::broll_panel_thumbs,
            spyglass::find_spyglass_index,
            spyglass::spyglass_choose_index,
            spyglass::spyglass_folder_children,
            spyglass::spyglass_resolve_scope,
            spyglass::spyglass_browse,
            spyglass::spyglass_keyframes,
            spyglass::spyglass_prepare_drag,
            spyglass::spyglass_start_drag,
        ])
        .build(tauri::generate_context!())
        .expect("error while building VibeCut Agent");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Never leave Python processes behind.
            app.state::<SidecarJobs>().kill_all();
        }
    });
}
