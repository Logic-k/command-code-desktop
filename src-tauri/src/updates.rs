//! Keeping the app and the CLI current.
//!
//! * **CLI**: `cmd update [--check-only]`, run headless. The CLI also
//!   auto-updates itself in the background; new agents pick up the new version
//!   because `launch::resolve_launch` re-reads the install on every spawn.
//! * **App**: the app is built from a local git checkout (the user's source
//!   folder, baked in at build time). It compares the commit it was built from
//!   with that folder's HEAD; when they differ, `app_update_build` builds a
//!   release in a separate target dir (the running exe stays unlocked) and
//!   `app_update_apply` swaps the exe once the app has exited, then relaunches.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::launch::{child_env, resolve_launch};

/// Emitted when the installed CLI version changes while the app runs
/// (the CLI auto-updates itself); payload `{ from, to }`.
pub const CLI_VERSION_EVENT: &str = "cli://version";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The commit this binary was built from (`build.rs`), empty if unknown.
const BUILT_COMMIT: &str = env!("CMDC_GIT_COMMIT");
/// The checkout this binary was built from: `src-tauri`'s parent.
const SOURCE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = hidden(Command::new("git").current_dir(dir).args(args)).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn source_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(SOURCE_DIR);
    if !dir.join("package.json").is_file() {
        return None;
    }
    // canonicalize() yields a verbatim `\\?\` path on Windows; git and people
    // both prefer the plain form.
    let full = dir.canonicalize().unwrap_or(dir);
    let text = full.to_string_lossy();
    Some(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub commit: String,
    pub debug: bool,
    pub source_dir: Option<String>,
    /// HEAD of the source folder, when it is a git checkout.
    pub source_commit: Option<String>,
    /// Commits in the source folder newer than this build.
    pub commits_behind: Option<u32>,
    /// Subjects of those commits, newest first (at most 20).
    pub changes: Vec<String>,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let source = source_dir();
    let source_commit = source.as_deref().and_then(|dir| git(dir, &["rev-parse", "HEAD"]));
    let (commits_behind, changes) = match (&source, &source_commit) {
        (Some(dir), Some(head)) if !BUILT_COMMIT.is_empty() && head != BUILT_COMMIT => {
            let range = format!("{BUILT_COMMIT}..{head}");
            let count = git(dir, &["rev-list", "--count", &range]).and_then(|n| n.parse().ok());
            let log = git(dir, &["log", "--format=%s", "-n", "20", &range])
                .map(|text| text.lines().map(str::to_string).collect())
                .unwrap_or_default();
            (count, log)
        }
        (Some(_), Some(_)) => (Some(0), Vec::new()),
        _ => (None, Vec::new()),
    };
    AppInfo {
        version: app.package_info().version.to_string(),
        commit: BUILT_COMMIT.to_string(),
        debug: cfg!(debug_assertions),
        source_dir: source.map(|d| d.to_string_lossy().into_owned()),
        source_commit,
        commits_behind,
        changes,
    }
}

/// The update build in progress, if any: the pid of the step being run.
/// Only one build may run, and none may outlive the app.
#[derive(Default)]
pub struct UpdateBuild(std::sync::Mutex<Option<u32>>);

impl UpdateBuild {
    /// Stop the running build and everything it started (pnpm, cargo, rustc).
    pub fn kill(&self) {
        if let Some(pid) = self.0.lock().ok().and_then(|mut current| current.take()) {
            kill_tree(pid);
        }
    }
}

fn kill_tree(pid: u32) {
    let _ = hidden(
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .status();
}

fn alive(pid: u32) -> bool {
    hidden(Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]))
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

/// Build the latest source into the app data dir, streaming the build log.
/// Returns the new executable's path.
///
/// Update builds trade the release profile's link-time optimisation for speed
/// (LTO off, parallel codegen, incremental), so a rebuild after a small change
/// takes about a minute instead of several. Shipping builds made with
/// `pnpm tauri build` keep the full profile.
#[tauri::command]
pub async fn app_update_build(app: AppHandle, on_log: Channel<String>) -> Result<String, String> {
    let dir = source_dir().ok_or("소스 폴더를 찾지 못했습니다.")?;
    let target = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("update-build");
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let pid_file = target.join("build.pid");

    {
        let current = app.state::<UpdateBuild>();
        let current = current.0.lock().map_err(|e| e.to_string())?;
        if current.is_some_and(alive) {
            return Err("이미 업데이트를 빌드하고 있습니다.".into());
        }
    }
    // A build left by an earlier run of the app (closed mid-build) still holds
    // cargo's lock on this directory; end it instead of queueing behind it.
    if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
        if alive(pid) {
            let _ = on_log.send(format!("이전 실행에서 남은 빌드(pid {pid})를 정리합니다."));
            kill_tree(pid);
        }
        let _ = std::fs::remove_file(&pid_file);
    }

    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let run = |label: &str, args: &[&str]| -> Result<(), String> {
            let _ = on_log.send(format!("$ {label}"));
            let mut child = hidden(
                Command::new("cmd")
                    .arg("/C")
                    .args(args)
                    .current_dir(&dir)
                    .env("CARGO_TARGET_DIR", &target)
                    .env("CARGO_PROFILE_RELEASE_LTO", "false")
                    .env("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "16")
                    .env("CARGO_PROFILE_RELEASE_INCREMENTAL", "true")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped()),
            )
            .spawn()
            .map_err(|e| format!("{label}: {e}"))?;
            if let Ok(mut current) = handle.state::<UpdateBuild>().0.lock() {
                *current = Some(child.id());
            }
            let _ = std::fs::write(&pid_file, child.id().to_string());
            let stderr = child.stderr.take();
            let log = on_log.clone();
            let err_thread = std::thread::spawn(move || {
                if let Some(stderr) = stderr {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        let _ = log.send(strip_ansi(&line));
                    }
                }
            });
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = on_log.send(strip_ansi(&line));
                }
            }
            let _ = err_thread.join();
            let status = child.wait().map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("{label} 실패 (종료 코드 {:?})", status.code()))
            }
        };
        let started = std::time::SystemTime::now();
        let outcome = run("pnpm install", &["pnpm", "install", "--frozen-lockfile"])
            .and_then(|_| run("pnpm tauri build", &["pnpm", "tauri", "build", "--no-bundle"]));
        let _ = std::fs::remove_file(&pid_file);
        outcome?;
        let exe = target.join("release").join("cmdc-gui.exe");
        // A build that did not write the exe (cancelled, stale) is not an update.
        let fresh = std::fs::metadata(&exe)
            .and_then(|m| m.modified())
            .is_ok_and(|modified| modified >= started);
        if !fresh {
            return Err(format!("빌드는 끝났지만 새 실행 파일이 만들어지지 않았습니다: {}", exe.display()));
        }
        Ok(exe.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(mut current) = app.state::<UpdateBuild>().0.lock() {
        *current = None;
    }
    result
}

/// Replace the running exe with `new_exe` and restart: a hidden PowerShell
/// waits for this process to exit, copies the file, and relaunches it.
#[tauri::command]
pub fn app_update_apply(app: AppHandle, new_exe: String) -> Result<(), String> {
    let new_exe = PathBuf::from(new_exe);
    if !new_exe.is_file() {
        return Err("새 실행 파일이 없습니다. 다시 빌드해 주세요.".into());
    }
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
    let script = format!(
        "Wait-Process -Id {pid} -ErrorAction SilentlyContinue; \
         $ok = $false; foreach ($i in 1..20) {{ try {{ Copy-Item -LiteralPath {src} -Destination {dst} -Force -ErrorAction Stop; $ok = $true; break }} catch {{ Start-Sleep -Milliseconds 500 }} }}; \
         Start-Process -FilePath {dst}",
        pid = std::process::id(),
        src = quote(&new_exe),
        dst = quote(&current),
    );
    hidden(
        Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .spawn()
    .map_err(|e| format!("업데이트 도우미를 시작하지 못했습니다: {e}"))?;
    app.exit(0);
    Ok(())
}

#[derive(Clone, Serialize)]
struct VersionChange {
    from: Option<String>,
    to: Option<String>,
}

/// Watch the installed CLI version. `resolve_launch` re-reads the npm install
/// on every spawn, so new agents already get a new version; this tells the
/// frontend so it can move running chats over as well.
pub fn start_version_watch(app: &AppHandle) {
    use tauri::Emitter;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = resolve_launch().version;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            let now = resolve_launch().version;
            if now != last {
                let _ = app.emit(
                    CLI_VERSION_EVENT,
                    VersionChange {
                        from: last.clone(),
                        to: now.clone(),
                    },
                );
                last = now;
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// What this app relies on inside the installed CLI, checked against its
/// bundle so a CLI update that changes one of them is noticed instead of
/// failing quietly. Runtime checks (ACP handshake, catalog, billing) are done
/// by the frontend with the live data it already has.
#[tauri::command]
pub fn cli_compat() -> Vec<Check> {
    let launch = resolve_launch();
    let mut checks = vec![Check {
        name: "CLI 실행 경로".into(),
        ok: launch.via == "node",
        detail: launch
            .entry
            .clone()
            .unwrap_or_else(|| "npm 심으로 실행 (node 경로를 찾지 못함)".into()),
    }];
    let bundle = launch
        .entry
        .as_deref()
        .map(|entry| Path::new(entry).with_file_name("cli.mjs"))
        .and_then(|path| std::fs::read_to_string(path).ok());
    let Some(bundle) = bundle else {
        checks.push(Check {
            name: "CLI 번들".into(),
            ok: false,
            detail: "dist/cli.mjs를 읽지 못했습니다.".into(),
        });
        return checks;
    };
    let needs = [
        ("계정 전환 (COMMAND_CODE_API_KEY)", "getCommandApiKeyFromEnv", "환경변수 키 우선 사용"),
        ("ACP 서버 (cmd acp)", "session/request_permission", "채팅·권한 요청"),
        ("세션 목록·불러오기", "session/load", "지난 대화 이어 하기"),
        ("모델 최소 요금제 (minimumPlan)", "minimumPlan", "모델 사용 가능 여부"),
        ("요금·크레딧 API", "/alpha/billing/credits", "사용량 게이지"),
        ("사용 한도 창 (windowLimits)", "windowLimits", "5시간·주간 한도 게이지"),
    ];
    for (name, marker, purpose) in needs {
        let ok = bundle.contains(marker);
        checks.push(Check {
            name: name.into(),
            ok,
            detail: if ok {
                purpose.into()
            } else {
                format!("CLI에서 `{marker}`를 찾지 못했습니다 — {purpose} 기능이 바뀌었을 수 있습니다.")
            },
        });
    }
    checks
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    pub output: String,
    pub version: Option<String>,
}

/// `cmd update` (or `--check-only`), headless. Returns the CLI's own message
/// and the version installed afterwards.
#[tauri::command]
pub async fn cli_update(check_only: bool) -> Result<CliUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let launch = resolve_launch();
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.prefix_args)
            .arg("update")
            .env_clear()
            .envs(child_env(None, None)?)
            .stdin(Stdio::null());
        if check_only {
            cmd.arg("--check-only");
        }
        let output = hidden(&mut cmd).output().map_err(|e| format!("cmd update: {e}"))?;
        let text = strip_ansi(&format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("- "))
            .collect();
        Ok(CliUpdate {
            output: lines.join("\n"),
            version: resolve_launch().version,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
