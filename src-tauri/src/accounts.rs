//! Command Code accounts: live login state, saved accounts, and switching.
//!
//! The CLI takes `COMMAND_CODE_API_KEY` over `~/.commandcode/auth.json`
//! (`getCommandAuthKey`, command-code 1.86-1.87), so an account is just a
//! key: starting the CLI with another key switches accounts while sessions,
//! settings, skills and the user's git config stay shared.
//!
//! * **CLI login** is whatever `cmd login` wrote to `auth.json` under
//!   `os.homedir()` (USERPROFILE on Windows). Chats that pick no saved account
//!   run as it.
//! * **Saved accounts** keep their key in Windows Credential Manager (DPAPI,
//!   per Windows user) and their id and name in the app data dir. No key ever
//!   crosses into the webview: the frontend names an account by id and Rust
//!   injects the key when it spawns the CLI.
//!
//! Everything is live. A watcher thread polls (cheap `stat`s, sub-second):
//! * the CLI's `auth.json`, so a login or logout done anywhere (a terminal tab,
//!   the user's own shell) reaches the app as `accounts://changed`;
//! * pending add-account logins. `cmd login` runs with a throwaway home under
//!   the app data dir; the moment its `auth.json` appears the key is moved into
//!   Credential Manager and `accounts://login-complete` fires. Waiting for the
//!   process to exit does not work: after signing in, `cmd login` carries on
//!   into onboarding instead of exiting.
//!
//! Logins interrupted by a closed app are recovered at the next start.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::launch::{child_env, resolve_launch};

const KEYRING_SERVICE: &str = "command-code-desktop";
const STORE_FILE: &str = "accounts.json";
const LOGIN_DIR: &str = "login";
const POLL: Duration = Duration::from_millis(700);

/// The CLI's own login changed (login, logout, re-login).
pub const CHANGED_EVENT: &str = "accounts://changed";
/// An add-account login finished; payload `LoginDone`.
pub const LOGIN_COMPLETE_EVENT: &str = "accounts://login-complete";
/// An add-account login produced credentials we could not use; payload `LoginFailed`.
pub const LOGIN_FAILED_EVENT: &str = "accounts://login-failed";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub user_name: String,
    pub added_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    /// Who `cmd login` signed in as; None when the CLI is logged out.
    pub cli_user: Option<String>,
    pub accounts: Vec<Account>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginDone {
    dir: String,
    account: Account,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginFailed {
    dir: String,
    error: String,
}

/// Add-account logins in progress (their throwaway homes).
#[derive(Default)]
pub struct PendingLogins(Mutex<HashSet<PathBuf>>);

/// The fields of `auth.json` we need. `apiKey` is only ever read from a login
/// home we created ourselves, never from the user's own `auth.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFile {
    api_key: Option<String>,
    user_name: Option<String>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn login_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(LOGIN_DIR))
}

fn load(app: &AppHandle) -> Result<Vec<Account>, String> {
    let path = data_dir(app)?.join(STORE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(app: &AppHandle, accounts: &[Account]) -> Result<(), String> {
    let path = data_dir(app)?.join(STORE_FILE);
    let text = serde_json::to_string_pretty(accounts).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| format!("credential store: {e}"))
}

fn auth_path(home: &Path) -> PathBuf {
    home.join(".commandcode").join("auth.json")
}

fn read_auth(home: &Path) -> Option<AuthFile> {
    let text = std::fs::read_to_string(auth_path(home)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The home the CLI reads `auth.json` from: `os.homedir()`, i.e. USERPROFILE.
fn cli_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// Cheap identity of the CLI's `auth.json`: changes on login, logout and
/// re-login without reading the key.
fn cli_fingerprint() -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(auth_path(&cli_home()?)).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The key to inject for `account_id`; `None` means "use the CLI's own login".
pub fn api_key_for(account_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = account_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    entry(id)?
        .get_password()
        .map(Some)
        .map_err(|e| format!("저장된 계정 키를 읽지 못했습니다 ({id}): {e}"))
}

/// Remove a login home. Opening the sign-in page with USERPROFILE pointed here
/// makes Windows create an Internet Explorer cache profile inside it (hidden,
/// system and reparse-point folders), which `remove_dir_all` cannot delete;
/// `rmdir /s /q` can.
fn remove_tree(dir: &Path) -> bool {
    if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "rmdir", "/S", "/Q"])
            .arg(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }
    !dir.exists()
}

/// Delete a login home in the background. The `cmd login` that ran in it may
/// still be exiting and holding the folder open, so retry for a while.
fn remove_later(dir: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..40 {
            if remove_tree(&dir) {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

/// Move the key a finished `cmd login` left in `dir` into Credential Manager.
/// Logging in to an account that is already saved replaces its key.
fn import_login(app: &AppHandle, dir: &Path) -> Result<Option<Account>, String> {
    let Some(auth) = read_auth(dir) else {
        return Ok(None);
    };
    let Some(key) = auth.api_key.filter(|k| !k.is_empty()) else {
        return Ok(None);
    };
    let user_name = auth.user_name.unwrap_or_else(|| "이름 없는 계정".into());

    let mut accounts = load(app)?;
    let account = match accounts.iter().find(|a| a.user_name == user_name) {
        Some(existing) => existing.clone(),
        None => {
            let now = now_millis();
            let account = Account {
                id: format!("acct-{now}"),
                user_name,
                added_at: (now / 1000) as u64,
            };
            accounts.push(account.clone());
            account
        }
    };
    entry(&account.id)?
        .set_password(&key)
        .map_err(|e| format!("credential store: {e}"))?;
    save(app, &accounts)?;
    Ok(Some(account))
}

/// Startup: no login can be in progress yet, so every login home is either a
/// finished login the app never collected (import it) or debris (delete it).
fn recover_logins(app: &AppHandle) {
    let Ok(root) = login_root(app) else { return };
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let dir = entry.path();
        if let Err(error) = import_login(app, &dir) {
            eprintln!("recovering login {}: {error}", dir.display());
        }
        remove_later(dir);
    }
}

/// Recover interrupted logins, then watch login state for the app's lifetime.
pub fn start(app: &AppHandle) {
    recover_logins(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = cli_fingerprint();
        loop {
            std::thread::sleep(POLL);

            let now = cli_fingerprint();
            if now != last {
                last = now;
                let _ = app.emit(CHANGED_EVENT, ());
            }

            let pending: Vec<PathBuf> = app
                .state::<PendingLogins>()
                .0
                .lock()
                .map(|set| set.iter().cloned().collect())
                .unwrap_or_default();
            for dir in pending {
                if !auth_path(&dir).is_file() {
                    continue;
                }
                // Give the CLI a beat to finish writing the file.
                std::thread::sleep(Duration::from_millis(300));
                let result = import_login(&app, &dir);
                if matches!(result, Ok(None)) {
                    continue; // Partially written; try again next tick.
                }
                if let Ok(mut set) = app.state::<PendingLogins>().0.lock() {
                    set.remove(&dir);
                }
                let dir_text = dir.to_string_lossy().into_owned();
                match result {
                    Ok(Some(account)) => {
                        let _ = app.emit(LOGIN_COMPLETE_EVENT, LoginDone { dir: dir_text, account });
                    }
                    Err(error) => {
                        let _ = app.emit(LOGIN_FAILED_EVENT, LoginFailed { dir: dir_text, error });
                    }
                    Ok(None) => {}
                }
                // The frontend kills the login terminal; the folder goes after it.
                remove_later(dir);
            }
        }
    });
}

#[tauri::command]
pub fn account_list(app: AppHandle) -> Result<AccountsView, String> {
    let cli_user = cli_home().and_then(|home| read_auth(&home)).and_then(|auth| auth.user_name);
    Ok(AccountsView {
        cli_user,
        accounts: load(&app)?,
    })
}

/// A fresh, empty home for `cmd login` to write into, now watched.
#[tauri::command]
pub fn account_login_begin(app: AppHandle) -> Result<String, String> {
    let dir = login_root(&app)?.join(format!("{}-{}", now_millis(), std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.state::<PendingLogins>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(dir.clone());
    Ok(dir.to_string_lossy().into_owned())
}

/// Drop a login that was abandoned (tab closed before signing in).
#[tauri::command]
pub fn account_login_cancel(app: AppHandle, dir: String) -> Result<(), String> {
    let root = login_root(&app)?;
    let dir = PathBuf::from(dir);
    let was_pending = app
        .state::<PendingLogins>()
        .0
        .lock()
        .map(|mut set| set.remove(&dir))
        .unwrap_or(false);
    if was_pending && dir.starts_with(&root) && dir != root {
        remove_later(dir);
    }
    Ok(())
}

#[tauri::command]
pub fn account_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut accounts = load(&app)?;
    accounts.retain(|a| a.id != id);
    save(&app, &accounts)?;
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("credential store: {e}")),
    }
}

/// `cmd logout` for the CLI's own login. The watcher sees `auth.json` go and
/// tells the frontend, which reconnects every chat that ran as it.
#[tauri::command]
pub async fn cli_logout() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let launch = resolve_launch();
        let mut cmd = std::process::Command::new(&launch.program);
        cmd.args(&launch.prefix_args)
            .arg("logout")
            .env_clear()
            .envs(child_env(None, None)?)
            .env_remove("COMMAND_CODE_API_KEY")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let status = cmd.status().map_err(|e| format!("cmd logout: {e}"))?;
        let still_there = cli_home().is_some_and(|home| auth_path(&home).is_file());
        if still_there {
            return Err(format!("로그아웃하지 못했습니다 (cmd logout 종료 코드 {:?}).", status.code()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
