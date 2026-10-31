//! First-run setup for machines without the Command Code CLI.
//!
//! Nothing is installed system-wide: Node's official archive is unpacked into
//! `<app local data>/runtime/node` after checking it against nodejs.org's
//! `SHASUMS256.txt`, and the CLI comes from npm with `--prefix
//! <runtime>/cli`. No admin rights, no PATH changes; `launch::resolve_launch`
//! picks this copy up when the user has no CLI of their own.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

use crate::launch::{self, resolve_launch};
use crate::updates::strip_ansi;

const DIST: &str = "https://nodejs.org/dist";
/// The oldest Node the CLI runs on.
const MIN_NODE_MAJOR: u64 = 22;
/// npm spec for the CLI: 1.88.0-1.88.1 crash on the first launch after a
/// fresh install (fixed in 1.88.2).
const CLI_SPEC: &str = "command-code@>=1.88.2";

static BUSY: AtomicBool = AtomicBool::new(false);

/// HTTP with deadlines: a stalled connection fails the setup (and frees it
/// for a retry) instead of hanging it. The read deadline is per read, so a
/// slow but moving download still finishes.
fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(60))
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    /// Whether any CLI can be started.
    pub cli_installed: bool,
    pub cli_version: Option<String>,
    /// `system` (the user's own install) or `app` (installed by this setup).
    pub cli_source: Option<String>,
    /// The app-private Node's version, when unpacked.
    pub app_node: Option<String>,
    pub runtime_dir: Option<String>,
}

fn hidden(cmd: &mut Command) -> &mut Command {
    crate::procs::background(cmd)
}

fn node_version(node: &Path) -> Option<String> {
    let output = hidden(Command::new(node).arg("--version").stdin(Stdio::null())).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub fn setup_status() -> SetupStatus {
    let launch = resolve_launch();
    let installed = launch::cli_installed(&launch);
    SetupStatus {
        cli_installed: installed,
        cli_version: launch.version.clone(),
        cli_source: installed.then(|| if launch::is_private(&launch) { "app" } else { "system" }.to_string()),
        app_node: launch::private_node().as_deref().and_then(node_version),
        runtime_dir: launch::runtime_dir().map(|d| d.to_string_lossy().into_owned()),
    }
}

/// Install the app-private Node (unless already there) and the CLI, streaming
/// progress lines. Returns the status afterwards.
#[tauri::command]
pub async fn setup_install(on_log: Channel<String>) -> Result<SetupStatus, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("이미 설치하고 있습니다.".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || install(&on_log))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    BUSY.store(false, Ordering::SeqCst);
    result?;
    Ok(setup_status())
}

fn install(log: &Channel<String>) -> Result<(), String> {
    let root = launch::runtime_dir().ok_or("앱 데이터 폴더를 찾지 못했습니다.")?.to_path_buf();
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    match launch::private_node().as_deref().and_then(node_version) {
        Some(version) => {
            let _ = log.send(format!("앱 전용 Node.js {version}이(가) 이미 있습니다."));
        }
        None => install_node(&root, log)?,
    }
    install_cli(&root, log)
}

/// nodejs.org's name for this machine's build and its archive type.
fn platform() -> Result<(&'static str, &'static str), String> {
    let arm = cfg!(target_arch = "aarch64");
    if cfg!(windows) {
        Ok((if arm { "win-arm64" } else { "win-x64" }, "zip"))
    } else if cfg!(target_os = "macos") {
        Ok((if arm { "darwin-arm64" } else { "darwin-x64" }, "tar.gz"))
    } else {
        Err("이 운영체제는 자동 설치를 지원하지 않습니다.".into())
    }
}

fn major(version: &str) -> Option<u64> {
    version.trim_start_matches('v').split('.').next()?.parse().ok()
}

/// The newest LTS release (22 or later) with a build for `platform`.
fn latest_lts(platform: &str) -> Result<String, String> {
    // index.json lists files as `win-x64-zip`, `osx-arm64-tar`, …
    let files_key = match platform.split_once('-') {
        Some(("darwin", arch)) => format!("osx-{arch}-tar"),
        _ => format!("{platform}-zip"),
    };
    let index: Vec<serde_json::Value> = http().get(&format!("{DIST}/index.json"))
        .call()
        .map_err(|e| format!("Node.js 버전 목록을 받지 못했습니다: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    index
        .iter()
        .find(|release| {
            release["lts"].is_string()
                && release["version"].as_str().and_then(major).is_some_and(|m| m >= MIN_NODE_MAJOR)
                && release["files"]
                    .as_array()
                    .is_some_and(|files| files.iter().any(|f| f.as_str() == Some(files_key.as_str())))
        })
        .and_then(|release| release["version"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "이 컴퓨터에 맞는 Node.js LTS를 찾지 못했습니다.".into())
}

/// Download `url` to `dest`, reporting progress; returns the file's SHA-256.
fn download(url: &str, dest: &Path, log: &Channel<String>) -> Result<String, String> {
    let response = http().get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let total: Option<u64> = response.header("Content-Length").and_then(|v| v.parse().ok());
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut done, mut shown) = (0u64, 0u64);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("내려받기 중단: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let percent = done * 100 / total;
            if percent >= shown + 10 {
                shown = percent - percent % 10;
                let _ = log.send(format!("  {percent}% ({} / {} MB)", done >> 20, total >> 20));
            }
        }
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The system's own tar. Windows ships bsdtar, which also reads zip; name it by
/// full path, because a Git for Windows GNU tar earlier on PATH reads neither
/// zip nor `C:\` paths.
fn tar() -> Command {
    if cfg!(windows) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        Command::new(Path::new(&root).join("System32").join("tar.exe"))
    } else {
        Command::new("/usr/bin/tar")
    }
}

fn install_node(root: &Path, log: &Channel<String>) -> Result<(), String> {
    let (platform, ext) = platform()?;
    let _ = log.send("Node.js LTS 버전을 확인합니다…".into());
    let version = latest_lts(platform)?;
    let name = format!("node-{version}-{platform}");
    let file = format!("{name}.{ext}");
    let url = format!("{DIST}/{version}/{file}");

    let sums = http().get(&format!("{DIST}/{version}/SHASUMS256.txt"))
        .call()
        .map_err(|e| format!("체크섬 목록을 받지 못했습니다: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let expected = sums
        .lines()
        .find_map(|line| line.strip_suffix(&format!("  {file}")))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("체크섬 목록에 {file}이(가) 없습니다."))?;

    let _ = log.send(format!("Node.js {version} 내려받는 중: {url}"));
    let archive = root.join(&file);
    let actual = download(&url, &archive, log)?;
    if actual != expected {
        let _ = std::fs::remove_file(&archive);
        return Err(format!("내려받은 파일의 체크섬이 맞지 않습니다 ({file}). 다시 시도해 주세요."));
    }
    let _ = log.send("체크섬 확인 완료 · 압축을 푸는 중…".into());

    let staging = root.join("node-unpack");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let output = hidden(tar().arg("-xf").arg(&archive).arg("-C").arg(&staging).stdin(Stdio::null()))
        .output()
        .map_err(|e| format!("tar: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("압축을 풀지 못했습니다: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let target = root.join("node");
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(staging.join(&name), &target).map_err(|e| format!("{}: {e}", target.display()))?;
    let _ = std::fs::remove_dir_all(&staging);

    let installed = launch::private_node()
        .as_deref()
        .and_then(node_version)
        .ok_or("Node.js를 풀었지만 실행되지 않습니다.")?;
    let _ = log.send(format!("Node.js {installed} 준비 완료"));
    Ok(())
}

fn install_cli(root: &Path, log: &Channel<String>) -> Result<(), String> {
    let node = launch::private_node().ok_or("앱 전용 Node.js가 없습니다.")?;
    // npm's own entry point, run with our node: no npm.cmd, so no cmd.exe.
    let npm_cli = if cfg!(windows) { root.join("node").join("node_modules") } else { root.join("node").join("lib").join("node_modules") }
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    let prefix = root.join("cli");
    let _ = log.send(format!("$ npm install -g {CLI_SPEC}"));
    let mut cmd = Command::new(&node);
    cmd.arg(&npm_cli)
        .args(["install", "-g", CLI_SPEC, "--no-fund", "--no-audit", "--loglevel", "warn", "--prefix"])
        .arg(&prefix)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = launch::prepend_path(&launch::private_path_dirs(), std::env::var("PATH").ok().as_deref()) {
        cmd.env("PATH", path);
    }
    run_logged(&mut cmd, log).map_err(|e| format!("CLI 설치 실패: {e}"))?;

    let launch = resolve_launch();
    if !launch::cli_installed(&launch) {
        return Err("설치는 끝났지만 CLI를 찾지 못했습니다.".into());
    }
    let _ = log.send(format!("Command Code CLI {} 설치 완료", launch.version.as_deref().unwrap_or("")));
    Ok(())
}

/// Run `cmd` to completion, sending each output line to `log`.
fn run_logged(cmd: &mut Command, log: &Channel<String>) -> Result<(), String> {
    let mut child = hidden(cmd).spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take();
    let err_log = log.clone();
    let err_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = err_log.send(strip_ansi(&line));
            }
        }
    });
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = log.send(strip_ansi(&line));
        }
    }
    let _ = err_thread.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("종료 코드 {:?}", status.code()))
    }
}

/// `<app local data>/runtime`: local, not roaming, since Node is ~100 MB.
pub fn runtime_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join("runtime"))
}
