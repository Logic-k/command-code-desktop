//! Chat tabs: run `cmd acp` (Agent Client Protocol over stdio) and shuttle its
//! newline-delimited JSON-RPC between the process and the frontend.
//!
//! Rust only moves lines; every JSON-RPC message is parsed in TypeScript
//! (`src/acp/client.ts`), so a protocol change never needs a Rust rebuild.
//!
//! One agent process serves one project folder: `session/list` answers for the
//! process's own cwd, and ACP lets several sessions share one connection.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::launch::{Launch, child_env, resolve_launch};

/// Emitted when an agent process exits.
pub const EXIT_EVENT: &str = "acp://exit";

/// Stops Windows from flashing a console window for the node child.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One agent process. Each part has its own lock so a slow write to one
/// agent never blocks the registry or any other agent.
struct Agent {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

impl Agent {
    /// Kill the agent and everything it started (shell commands, dev servers):
    /// killing only `node` would orphan its tool processes on Windows.
    fn kill_tree(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Live agent processes, keyed by the frontend's connection id.
#[derive(Clone, Default)]
pub struct AcpManager(Arc<Mutex<HashMap<String, Arc<Agent>>>>);

impl AcpManager {
    /// Kill every agent; called when the app exits so no node child outlives it.
    pub fn kill_all(&self) {
        let agents: Vec<Arc<Agent>> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, agent)| agent).collect(),
            Err(_) => return,
        };
        for agent in agents {
            agent.kill_tree();
        }
    }
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

/// Start `cmd acp` in `cwd`. Each stdout line (one JSON-RPC message) goes to
/// `on_message`; each stderr line (the agent's own log) goes to `on_log`.
#[tauri::command]
pub fn acp_spawn(
    app: AppHandle,
    manager: State<'_, AcpManager>,
    id: String,
    cwd: String,
    profile_dir: Option<String>,
    on_message: Channel<String>,
    on_log: Channel<String>,
) -> Result<Launch, String> {
    if cwd.trim().is_empty() || !Path::new(&cwd).is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }

    let launch = resolve_launch();
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.prefix_args)
        .arg("acp")
        .current_dir(&cwd)
        .env_clear()
        .envs(child_env(profile_dir.as_deref()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    {
        let mut map = manager.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&id) {
            let _ = child.kill();
            return Err(format!("agent {id} already exists"));
        }
        map.insert(
            id.clone(),
            Arc::new(Agent {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
            }),
        );
    }

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    if on_log.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let manager_handle = manager.inner().clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::with_capacity(64 * 1024);
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer);
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if on_message.send(line.to_string()).is_err() {
                        break;
                    }
                }
            }
        }
        let agent = manager_handle.0.lock().ok().and_then(|mut map| map.remove(&id));
        let code = agent
            .and_then(|agent| agent.child.lock().ok().and_then(|mut child| child.wait().ok()))
            .and_then(|status| status.code());
        let _ = app.emit(EXIT_EVENT, ExitPayload { id, code });
    });

    Ok(launch)
}

/// Write one JSON-RPC message; the newline framing is added here. Async so the
/// write (which blocks when the agent stops reading) stays off the UI thread.
#[tauri::command]
pub async fn acp_send(manager: State<'_, AcpManager>, id: String, line: String) -> Result<(), String> {
    let agent = manager
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no agent {id}"))?;
    let mut stdin = agent.stdin.lock().map_err(|e| e.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"
"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
pub async fn acp_kill(manager: State<'_, AcpManager>, id: String) -> Result<(), String> {
    let agent = manager.0.lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(agent) = agent {
        // taskkill and wait() block; keep them off the async runtime's workers.
        let _ = tauri::async_runtime::spawn_blocking(move || agent.kill_tree()).await;
    }
    Ok(())
}
