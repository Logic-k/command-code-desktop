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

/// The executable name of a running process (`cmd.exe`, `sh`), or `None`
/// when no process has this id.
pub fn image_name(pid: u32) -> Option<String> {
    #[cfg(windows)]
    let out = background(Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    #[cfg(unix)]
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    parse_image_name(&String::from_utf8_lossy(&out.stdout), pid, cfg!(windows))
}

/// `"cmd.exe","1234",...` (tasklist CSV) or `/bin/sh` (ps). Any other tasklist
/// line is its localized "no tasks" notice: no process.
fn parse_image_name(text: &str, pid: u32, csv: bool) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    if !csv {
        return Some(line.rsplit('/').next().unwrap_or(line).to_string());
    }
    let mut fields = line.strip_prefix('"')?.split("\",\"");
    let name = fields.next()?;
    let id = fields.next()?;
    (id.trim_matches('"') == pid.to_string()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_image_name;

    #[test]
    fn reads_tasklist_csv() {
        let row = "\"cmd.exe\",\"4242\",\"Console\",\"1\",\"4,120 K\"\r\n";
        assert_eq!(parse_image_name(row, 4242, true).as_deref(), Some("cmd.exe"));
        assert_eq!(parse_image_name(row, 42, true), None);
    }

    #[test]
    fn no_process_is_none() {
        assert_eq!(parse_image_name("정보: 지정된 조건에 맞는 작업이 없습니다.\r\n", 4242, true), None);
        assert_eq!(parse_image_name("", 4242, false), None);
    }

    #[test]
    fn reads_ps_comm() {
        assert_eq!(parse_image_name("/bin/sh\n", 7, false).as_deref(), Some("sh"));
    }
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
