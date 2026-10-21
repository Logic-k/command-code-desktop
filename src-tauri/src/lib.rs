pub mod acp;
pub mod launch;
pub mod pty;

use acp::AcpManager;
use pty::PtyManager;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyManager::default())
        .manage(AcpManager::default())
        .invoke_handler(tauri::generate_handler![
            launch::cmdc_launch,
            launch::start_dir,
            launch::dir_exists,
            launch::read_transcript,
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
        }
    });
}
