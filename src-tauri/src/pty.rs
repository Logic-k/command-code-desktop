//! Terminal tabs: run the Command Code TUI under a real console (ConPTY on
//! Windows) and stream its bytes to the frontend.
//!
//! The chat tabs talk ACP instead (see `acp.rs`); this path stays for what only
//! the TUI does, such as `cmd login` and the full-screen `/config`.
//!
//! Output is base64-encoded and pushed over a Tauri `Channel`; a TUI redraw is
//! small enough that this stays well inside budget.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::launch::{Launch, child_env, resolve_launch};

/// Emitted with the session id when a child exits and its session is dropped.
pub const EXIT_EVENT: &str = "pty://exit";

const READ_BUFFER: usize = 16 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Session {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }
}

/// Shared registry of live PTY sessions, keyed by the frontend's tab id.
#[derive(Clone, Default)]
pub struct PtyManager(Arc<Mutex<HashMap<String, Session>>>);

impl PtyManager {
    /// Kill every child; called when the app exits so no TUI outlives it.
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    args: Vec<String>,
    profile_dir: Option<String>,
    account_id: Option<String>,
    on_output: Channel<String>,
) -> Result<Launch, String> {
    if cwd.trim().is_empty() || !Path::new(&cwd).is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }

    let launch = resolve_launch();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&launch.program);
    cmd.args(&launch.prefix_args);
    cmd.args(&args);
    cmd.cwd(Path::new(&cwd));

    // Seed the whole parent environment explicitly: CommandBuilder's
    // inheritance behaviour is not uniform across backends, and the child
    // needs PATH at minimum.
    for (key, value) in child_env(profile_dir.as_deref(), account_id.as_deref())? {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer failed: {e}"))?;

    {
        let mut map = manager.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&id) {
            return Err(format!("session {id} already exists"));
        }
        map.insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let manager_handle = manager.inner().clone();
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; READ_BUFFER];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    // A closed channel means the frontend tab is gone; stop reading.
                    if on_output.send(B64.encode(&buffer[..n])).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping the session closes the pty and reaps the child.
        if let Ok(mut map) = manager_handle.0.lock() {
            map.remove(&exit_id);
        }
        let _ = app.emit(EXIT_EVENT, exit_id);
    });

    Ok(launch)
}

#[tauri::command]
pub async fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("bad payload: {e}"))?;
    let mut map = manager.0.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
    session
        .writer
        .write_all(&bytes)
        .map_err(|e| format!("write failed: {e}"))?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = manager.0.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or_else(|| format!("no session {id}"))?;
    session.resize(cols, rows)
}

#[tauri::command]
pub async fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Ok(mut map) = manager.0.lock() {
        if let Some(mut session) = map.remove(&id) {
            let _ = session.child.kill();
        }
    }
    Ok(())
}
