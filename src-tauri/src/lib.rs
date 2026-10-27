pub mod accounts;
pub mod acp;
pub mod billing;
pub mod launch;
pub mod procs;
pub mod pty;
pub mod setup;
pub mod updates;

use acp::AcpManager;
use pty::PtyManager;
use tauri::{Emitter, Manager, RunEvent};

/// Sent to the window when a second launch asks for a folder.
const OPEN_FOLDER_EVENT: &str = "app://open-folder";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    launch::adopt_login_shell_path();

    let app = tauri::Builder::default()
        // Must be first: a second launch (`cmdc-gui.exe D:\project`,
        // a shortcut, a script) hands its folder to the running window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(dir) = launch::dir_from_args(args.into_iter().skip(1)) {
                let _ = app.emit(OPEN_FOLDER_EVENT, dir);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyManager::default())
        .manage(AcpManager::default())
        .manage(accounts::PendingLogins::default())
        .manage(updates::UpdateBuild::default())
        .setup(|app| {
            // Before anything resolves the CLI: the app-private install lives here.
            if let Some(dir) = setup::runtime_root(app.handle()) {
                launch::set_runtime_dir(dir);
            }
            accounts::start(app.handle());
            updates::start_version_watch(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            accounts::account_list,
            accounts::account_login_begin,
            accounts::account_login_cancel,
            accounts::account_remove,
            accounts::cli_logout,
            billing::account_billing,
            billing::model_catalog,
            updates::app_info,
            updates::app_update_build,
            updates::app_update_apply,
            updates::cli_update,
            updates::cli_compat,
            setup::setup_status,
            setup::setup_install,
            launch::cmdc_launch,
            launch::start_dir,
            launch::dir_exists,
            launch::read_transcript,
            launch::read_image,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            acp::acp_spawn,
            acp::acp_send,
            acp::acp_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // No CLI child may outlive the window: a stray agent keeps burning
        // credits and a stray TUI holds the project folder open.
        if let RunEvent::Exit = event {
            handle.state::<AcpManager>().kill_all();
            handle.state::<PtyManager>().kill_all();
            handle.state::<updates::UpdateBuild>().kill();
        }
    });
}
