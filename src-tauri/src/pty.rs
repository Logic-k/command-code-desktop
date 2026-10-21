//! PTY plumbing: run the Command Code CLI under a real console (ConPTY on
//! Windows) and stream its bytes to the frontend.
//!
//! Design notes
//! ------------
//! * `cmdc` on Windows is an npm shim (`cmdc.cmd`) that runs
//!   `node <npm-bin>/node_modules/command-code/dist/index.mjs`. We resolve that
//!   layout ourselves and spawn `node` directly, so the TUI runs under a real
//!   ConPTY with no `cmd.exe` layer in between. If resolution fails we fall back
//!   to the shim through `%COMSPEC%`.
//! * The child environment is seeded from this process and then overridden, so
//!   the profile knob (`USERPROFILE`) isolates `~/.commandcode` per account while
//!   PATH and the rest still work.
//! * Output is base64-encoded and pushed over a Tauri `Channel`; a TUI redraw is
//!   small enough that this stays well inside budget.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

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

/// How we decided to launch the CLI. Surfaced to the frontend for diagnostics.
#[derive(Clone, Serialize)]
pub struct Launch {
    /// Executable to spawn (`node.exe`, or `%COMSPEC%` on the shim fallback).
    pub program: String,
    /// Arguments that must precede the user's arguments.
    pub prefix_args: Vec<String>,
    /// `node` when we resolved the package entry, `shim` when we fell back.
    pub via: String,
    /// The resolved `dist/index.mjs`, when known.
    pub entry: Option<String>,
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Resolve the CLI the same way the npm shim does, without needing the shim.
pub fn resolve_launch() -> Launch {
    let shim = find_on_path("cmdc.cmd").or_else(|| find_on_path("cmdc"));
    if let Some(shim) = shim {
        if let Some(dir) = shim.parent() {
            let entry = dir
                .join("node_modules")
                .join("command-code")
                .join("dist")
                .join("index.mjs");
            if entry.is_file() {
                let local_node = dir.join("node.exe");
                let program = if local_node.is_file() {
                    local_node.to_string_lossy().into_owned()
                } else {
                    "node".to_string()
                };
                return Launch {
                    program,
                    prefix_args: vec![entry.to_string_lossy().into_owned()],
                    via: "node".to_string(),
                    entry: Some(entry.to_string_lossy().into_owned()),
                };
            }
        }
    }

    Launch {
        program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
        prefix_args: vec!["/c".to_string(), "cmdc".to_string()],
        via: "shim".to_string(),
        entry: None,
    }
}

#[tauri::command]
pub fn cmdc_launch() -> Launch {
    resolve_launch()
}

/// A folder to open on launch: `CMDC_GUI_START_DIR`, else the first positional
/// argument that names an existing directory. This is what makes the app usable
/// from a shortcut or a script (`cmdc-gui.exe D:\project`).
#[tauri::command]
pub fn start_dir() -> Option<String> {
    if let Ok(value) = std::env::var("CMDC_GUI_START_DIR") {
        if !value.trim().is_empty() && Path::new(&value).is_dir() {
            return Some(value);
        }
    }
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_dir())
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
    for arg in &launch.prefix_args {
        cmd.arg(arg);
    }
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(Path::new(&cwd));

    // Seed the whole parent environment first, then override. This is
    // deliberately belt-and-braces: CommandBuilder's inheritance behaviour is
    // not uniform across backends, and the child needs PATH at minimum.
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CMDC_GUI", "1");
    if let Some(dir) = profile_dir.as_ref().map(String::as_str).filter(|d| !d.is_empty()) {
        // USERPROFILE is the knob that moves ~/.commandcode; HOME follows it so
        // tools inside the session agree on where home is.
        cmd.env("USERPROFILE", dir);
        cmd.env("HOME", dir);
    }

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
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
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
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Ok(mut map) = manager.0.lock() {
        if let Some(mut session) = map.remove(&id) {
            let _ = session.child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    manager
        .0
        .lock()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}
