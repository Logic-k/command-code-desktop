//! Child processes that must not outlive what started them.
//!
//! The CLI agent and an update build both start further processes (shell
//! commands, dev servers, cargo, rustc). Killing only the direct child would
//! orphan those, so each such child is started as the root of its own tree and
//! the whole tree is ended together:
//! * Windows: `taskkill /T` walks the tree.
//! * macOS/Linux: the child leads a new process group; `kill -<pgid>` ends it.

use std::process::{Command, Stdio};

/// Stops Windows from flashing a console window for a background child.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Configure `cmd` to run in the background as the root of its own tree.
pub fn background(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// End `pid` and everything it started. Best effort: the tree may already be gone.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = background(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Whether a process with this id is still running.
pub fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        background(Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}
