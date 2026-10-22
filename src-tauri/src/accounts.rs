//! Saved Command Code accounts, switchable per chat.
//!
//! The CLI takes `COMMAND_CODE_API_KEY` over `~/.commandcode/auth.json`
//! (`getCommandAuthKey` in command-code 1.86), so switching an account means
//! starting the CLI with a different key: sessions, settings, skills and the
//! user's git config stay shared, unlike swapping the whole home directory.
//!
//! Keys live in Windows Credential Manager (DPAPI, per Windows user). The
//! list of accounts (id and display name only) lives in the app data dir.
//! No key ever crosses into the webview: the frontend names an account by id
//! and Rust injects the key when it spawns the CLI.
//!
//! Adding an account runs `cmd login` with a throwaway home under the app data
//! dir, then moves the key it wrote into Credential Manager and deletes that
//! home again.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "command-code-desktop";
const STORE_FILE: &str = "accounts.json";
const LOGIN_DIR: &str = "login";

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
    /// Who `cmd login` signed in as (the account used when none is chosen).
    pub cli_user: Option<String>,
    pub accounts: Vec<Account>,
}

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

fn read_auth(home: &Path) -> Option<AuthFile> {
    let text = std::fs::read_to_string(home.join(".commandcode").join("auth.json")).ok()?;
    serde_json::from_str(&text).ok()
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

#[tauri::command]
pub fn account_list(app: AppHandle) -> Result<AccountsView, String> {
    // The CLI reads auth.json from os.homedir(), which is USERPROFILE on Windows.
    let cli_user = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .and_then(|home| read_auth(&home))
        .and_then(|auth| auth.user_name);
    Ok(AccountsView {
        cli_user,
        accounts: load(&app)?,
    })
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
/// still be exiting and holding the folder open, so retry for a few seconds.
fn remove_later(dir: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..20 {
            if remove_tree(&dir) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

/// A fresh, empty home for `cmd login` to write into. Homes left behind by an
/// earlier run (crash, killed app) are swept here.
#[tauri::command]
pub fn account_login_begin(app: AppHandle) -> Result<String, String> {
    let root = data_dir(&app)?.join(LOGIN_DIR);
    if let Ok(entries) = std::fs::read_dir(&root) {
        let stale = std::time::Duration::from_secs(60 * 60);
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > stale);
            if old {
                remove_later(entry.path());
            }
        }
    }
    let dir = root.join(format!("{}-{}", now_millis(), std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Collect the key `cmd login` wrote into `dir`, store it, and delete `dir`.
/// Logging in to an account that is already saved replaces its key.
#[tauri::command]
pub fn account_login_finish(app: AppHandle, dir: String) -> Result<Account, String> {
    let login_root = data_dir(&app)?.join(LOGIN_DIR);
    let dir = PathBuf::from(dir);
    // Only ever read a home this module created.
    let inside = dir
        .canonicalize()
        .ok()
        .zip(login_root.canonicalize().ok())
        .is_some_and(|(dir, root)| dir != root && dir.starts_with(&root));
    if !inside {
        return Err("알 수 없는 로그인 폴더입니다.".into());
    }

    let auth = read_auth(&dir);
    remove_later(dir);
    let auth = auth.ok_or("로그인이 완료되지 않았습니다. 다시 시도해 주세요.")?;
    let key = auth
        .api_key
        .filter(|k| !k.is_empty())
        .ok_or("로그인 정보에 키가 없습니다.")?;
    let user_name = auth.user_name.unwrap_or_else(|| "이름 없는 계정".into());

    let mut accounts = load(&app)?;
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
    save(&app, &accounts)?;
    Ok(account)
}

/// Drop a login that was abandoned (window closed, user gave up).
#[tauri::command]
pub fn account_login_cancel(app: AppHandle, dir: String) -> Result<(), String> {
    let login_root = data_dir(&app)?.join(LOGIN_DIR);
    let dir = PathBuf::from(dir);
    if dir.starts_with(&login_root) && dir != login_root {
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
