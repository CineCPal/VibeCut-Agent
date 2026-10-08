mod audiosync;
mod broll_panel;
mod broll_preview;
mod chat_store;
mod claude_code;
mod commands;
mod login_item;
mod mcp_bridge;
mod mini_player;
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
        // The B-roll folder picker and the Analyze tab's XML save dialog (`dialog:allow-open` and `dialog:allow-save`, capabilities/default.json).
        .plugin(tauri_plugin_dialog::init())
        // "Open at login" (login_item.rs): a LaunchAgent, only when the user turns it on.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![login_item::AT_LOGIN_ARG])))
        .manage(AppState::default())
        .manage(SidecarJobs::default())
        .manage(AgentSession::default())
        .manage(Nle::default())
        .manage(Keys(Box::new(Keychain)))
        .manage(spyglass::ArchiveCache::default())
        .manage(audiosync::AudioSyncJobs::default())
        .manage(spyglass::DragCache::default())
        .manage(tray::KeepOnTopItem::default())
        .manage(tray::MiniPlayerItem::default())
        .manage(mini_player::MiniPlayer::default())
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
            // The installed app opened by hand (Spotlight, Launchpad, the Dock) shows its window; started at
            // login, or as a dev build, it stays in the menu bar (login_item.rs).
            if login_item::shows_window_at_launch(cfg!(debug_assertions), std::env::args()) {
                tray::show_main(app.handle());
            }
            // Old waveform envelopes of the audio sync (audiosync.rs) are cleared out now and then.
            audiosync::prune_in_background(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != tray::MAIN_WINDOW {
                return;
            }
            match event {
                // Closing hides the window; the app keeps living in the menu bar until "Quit".
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // The Mini Player remembers where it was dragged (mini_player.rs).
                WindowEvent::Moved(position) => mini_player::moved(window.app_handle(), window, *position),
                _ => {}
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
            mini_player::mini_player_status,
            mini_player::set_mini_player,
            login_item::open_at_login_status,
            login_item::set_open_at_login,
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
            claude_code::claude_code_usage,
            chat_store::chat_list,
            chat_store::chat_load,
            chat_store::chat_save,
            chat_store::chat_delete,
            chat_store::chat_rename,
            chat_store::chat_search,
            chat_store::chat_attachment_save,
            chat_store::chat_attachment_load,
            chat_store::edit_log_load,
            chat_store::edit_log_save,
            broll_panel::broll_panel_thumbs,
            broll_preview::broll_preview_allow,
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

    app.run(|app, event| match event {
        // Opened again while it runs (Spotlight, Launchpad, the Dock): show the window as it was.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::show_main(app),
        RunEvent::Exit => {
            mini_player::save_on_exit(app);
            // Never leave Python processes behind.
            app.state::<SidecarJobs>().kill_all();
        }
        _ => {}
    });
}
