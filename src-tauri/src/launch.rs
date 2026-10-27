//! Where the Command Code CLI lives and how to start it.
//!
//! The CLI is an npm package (`command-code`) whose bin, `cmdc`, runs
//! `node <prefix>/node_modules/command-code/dist/index.mjs`. We resolve that
//! entry ourselves and spawn `node` directly, so no shell sits between the app
//! and the CLI:
//! * Windows: `cmdc` is a `cmdc.cmd` shim next to `node_modules`; if the
//!   layout is unexpected we fall back to the shim through `%COMSPEC%`.
//! * macOS/Linux: `cmdc` is a symlink into the package; following it gives the
//!   entry. The fallback runs `cmdc` itself (its `#!/usr/bin/env node` line).
//!
//! A CLI the user installed comes first. Without one, the app-private install
//! the first-run setup makes (`setup.rs`: `<runtime>/node` and the npm prefix
//! `<runtime>/cli`) is used, and its Node goes first on the child's PATH.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

/// How we decided to launch the CLI. Surfaced to the frontend for diagnostics.
#[derive(Clone, Serialize)]
pub struct Launch {
    /// Executable to spawn (`node`, or the shim on the fallback).
    pub program: String,
    /// Arguments that must precede the user's arguments.
    pub prefix_args: Vec<String>,
    /// `node` when we resolved the package entry, `shim` when we fell back.
    pub via: String,
    /// The resolved `dist/index.mjs`, when known.
    pub entry: Option<String>,
    /// The installed `command-code` version, when known.
    pub version: Option<String>,
}

static RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the app-private Node and CLI live; set once at startup.
pub fn set_runtime_dir(dir: PathBuf) {
    let _ = RUNTIME_DIR.set(dir);
}

pub fn runtime_dir() -> Option<&'static Path> {
    RUNTIME_DIR.get().map(PathBuf::as_path)
}

/// The unpacked Node archive: `node.exe` sits at its root on Windows and in
/// `bin/` elsewhere.
pub fn private_node_dir() -> Option<PathBuf> {
    let node = runtime_dir()?.join("node");
    Some(if cfg!(windows) { node } else { node.join("bin") })
}

pub fn private_node() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    private_node_dir().map(|dir| dir.join(name)).filter(|p| p.is_file())
}

/// npm's global layout under `--prefix`: bins at the root and packages in
/// `node_modules` on Windows; `bin/` and `lib/node_modules` elsewhere.
fn private_cli_bin_dir() -> Option<PathBuf> {
    let cli = runtime_dir()?.join("cli");
    Some(if cfg!(windows) { cli } else { cli.join("bin") })
}

fn private_entry() -> Option<PathBuf> {
    let cli = runtime_dir()?.join("cli");
    let modules = if cfg!(windows) { cli.join("node_modules") } else { cli.join("lib").join("node_modules") };
    Some(modules.join("command-code").join("dist").join("index.mjs")).filter(|p| p.is_file())
}

fn private_launch() -> Option<Launch> {
    let node = private_node()?;
    Some(node_launch(node.to_string_lossy().into_owned(), &private_entry()?))
}

/// Whether `launch` runs the app-private CLI.
pub fn is_private(launch: &Launch) -> bool {
    let (Some(entry), Some(root)) = (launch.entry.as_deref(), runtime_dir()) else {
        return false;
    };
    Path::new(entry).starts_with(root)
}

/// Whether any CLI can be started: a resolved entry, or at least a `cmdc` shim.
pub fn cli_installed(launch: &Launch) -> bool {
    launch.entry.is_some() || find_on_path(if cfg!(windows) { "cmdc.cmd" } else { "cmdc" }).is_some()
}

/// The app-private Node and CLI bins, for the front of a child's PATH.
pub fn private_path_dirs() -> Vec<PathBuf> {
    [private_node_dir(), private_cli_bin_dir()].into_iter().flatten().collect()
}

/// `current` with `dirs` put in front.
pub fn prepend_path(dirs: &[PathBuf], current: Option<&str>) -> Option<String> {
    let mut parts = dirs.to_vec();
    if let Some(current) = current {
        parts.extend(std::env::split_paths(current));
    }
    std::env::join_paths(parts).ok().map(|p| p.to_string_lossy().into_owned())
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn package_version(package_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(package_dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// The user's home as Node's `os.homedir()` sees it (where the CLI keeps
/// `~/.commandcode/auth.json`): USERPROFILE on Windows, HOME elsewhere.
pub fn user_home() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key).map(PathBuf::from)
}

fn node_launch(node: String, entry: &Path) -> Launch {
    // dist/index.mjs → the package dir is two levels up.
    let package_dir = entry.parent().and_then(Path::parent);
    Launch {
        program: node,
        prefix_args: vec![entry.to_string_lossy().into_owned()],
        via: "node".to_string(),
        entry: Some(entry.to_string_lossy().into_owned()),
        version: package_dir.and_then(package_version),
    }
}

/// Resolve the CLI the same way the npm shim does, without needing the shim.
#[cfg(windows)]
pub fn resolve_launch() -> Launch {
    let shim = find_on_path("cmdc.cmd").or_else(|| find_on_path("cmdc"));
    if let Some(dir) = shim.as_deref().and_then(Path::parent) {
        let entry = dir.join("node_modules").join("command-code").join("dist").join("index.mjs");
        if entry.is_file() {
            let local_node = dir.join("node.exe");
            let node = if local_node.is_file() {
                local_node.to_string_lossy().into_owned()
            } else {
                "node".to_string()
            };
            return node_launch(node, &entry);
        }
    }
    if shim.is_none() {
        if let Some(launch) = private_launch() {
            return launch;
        }
    }

    Launch {
        program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
        prefix_args: vec!["/c".to_string(), "cmdc".to_string()],
        via: "shim".to_string(),
        entry: None,
        version: None,
    }
}

/// Resolve the CLI the same way the npm shim does, without needing the shim.
#[cfg(not(windows))]
pub fn resolve_launch() -> Launch {
    let Some(bin) = find_on_path("cmdc") else {
        if let Some(launch) = private_launch() {
            return launch;
        }
        return Launch {
            program: "cmdc".to_string(),
            prefix_args: Vec::new(),
            via: "shim".to_string(),
            entry: None,
            version: None,
        };
    };
    // npm links bin/cmdc → ../lib/node_modules/command-code/dist/index.mjs.
    if let Ok(entry) = bin.canonicalize() {
        if entry.file_name().is_some_and(|n| n == "index.mjs") && entry.is_file() {
            // Prefer the node that sits next to the bin (nvm, volta, Homebrew
            // keep them together); else whatever `node` PATH finds.
            let sibling = bin.with_file_name("node");
            let node = if sibling.is_file() {
                sibling.to_string_lossy().into_owned()
            } else {
                find_on_path("node")
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "node".to_string())
            };
            return node_launch(node, &entry);
        }
    }
    Launch {
        program: bin.to_string_lossy().into_owned(),
        prefix_args: Vec::new(),
        via: "shim".to_string(),
        entry: None,
        version: None,
    }
}

/// macOS starts apps from Finder/Dock with a bare PATH (`/usr/bin:/bin:…`), so
/// `node` and `cmdc` installed through Homebrew, nvm or volta are invisible.
/// Ask the user's login shell for its PATH once, before anything spawns, and
/// add the usual install locations in case the shell setup is unusual.
#[cfg(target_os = "macos")]
pub fn adopt_login_shell_path() {
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let from_shell = Command::new(&shell)
        .args(["-ilc", "printf '__PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
            text.rsplit_once("__PATH__").map(|(_, p)| p.trim().to_string())
        })
        .filter(|p| !p.is_empty());

    let mut parts: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !p.as_os_str().is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    };
    if let Some(path) = &from_shell {
        for p in std::env::split_paths(path) {
            push(p);
        }
    }
    if let Some(current) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&current) {
            push(p);
        }
    }
    if let Some(home) = user_home() {
        push(home.join(".volta/bin"));
        push(home.join(".npm-global/bin"));
    }
    push(PathBuf::from("/opt/homebrew/bin"));
    push(PathBuf::from("/usr/local/bin"));
    if let Ok(joined) = std::env::join_paths(parts) {
        // SAFETY: called first thing in `run()`, before Tauri or any of our
        // threads start, so nothing else reads the environment concurrently.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

/// The child environment: the whole parent environment, then our overrides.
///
/// * `profile_dir` moves the whole home (`~/.commandcode` and every other
///   home-relative config); only the add-account login uses it, so `cmd login`
///   writes into a throwaway home.
/// * `account_id` picks a saved account: its key goes in as
///   `COMMAND_CODE_API_KEY`, which the CLI prefers over `auth.json`.
/// * the app-private CLI gets its Node first on PATH (for the shell commands it
///   runs) and npm's global prefix pointed at its own install, so `cmd update`
///   updates that copy.
pub fn child_env(profile_dir: Option<&str>, account_id: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    env.push(("CMDC_GUI".into(), "1".into()));
    if is_private(&resolve_launch()) {
        // Windows spells it `Path`; replace that entry rather than add a second.
        let index = env.iter().position(|(k, _)| k.eq_ignore_ascii_case("PATH"));
        if let Some(path) = prepend_path(&private_path_dirs(), index.map(|i| env[i].1.as_str())) {
            match index {
                Some(i) => env[i].1 = path,
                None => env.push(("PATH".into(), path)),
            }
        }
        if let Some(root) = runtime_dir() {
            env.push(("npm_config_prefix".into(), root.join("cli").to_string_lossy().into_owned()));
        }
    }
    if let Some(dir) = profile_dir.filter(|d| !d.is_empty()) {
        env.push(("USERPROFILE".into(), dir.into()));
        env.push(("HOME".into(), dir.into()));
    }
    if let Some(key) = crate::accounts::api_key_for(account_id)? {
        env.push(("COMMAND_CODE_API_KEY".into(), key));
    }
    Ok(env)
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
    dir_from_args(std::env::args().skip(1))
}

/// The first argument that is an existing directory (flags skipped).
pub fn dir_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_dir())
}

/// Homes the CLI may be using: the account profile when one is set, else
/// `HOME` (Command Code prefers it when set) and then `USERPROFILE`.
fn cli_homes(profile_dir: Option<&str>) -> Vec<PathBuf> {
    if let Some(dir) = profile_dir.filter(|d| !d.is_empty()) {
        return vec![PathBuf::from(dir)];
    }
    ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(|key| std::env::var_os(key))
        .map(PathBuf::from)
        .collect()
}

/// The raw JSONL transcript of a session, read straight from
/// `~/.commandcode/projects/<slug>/<id>.jsonl`.
///
/// `session/load` is supposed to replay history, but `cmd acp` 1.86 often
/// replays nothing and takes seconds to answer, so the chat renders the
/// transcript itself and attaches to the live session in the background.
#[tauri::command]
pub fn read_transcript(session_id: String, profile_dir: Option<String>) -> Option<String> {
    // Session ids are UUIDs; anything else could walk out of the projects dir.
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let file_name = format!("{session_id}.jsonl");
    for home in cli_homes(profile_dir.as_deref()) {
        let Ok(projects) = std::fs::read_dir(home.join(".commandcode").join("projects")) else {
            continue;
        };
        for project in projects.flatten() {
            let candidate = project.path().join(&file_name);
            if candidate.is_file() {
                return std::fs::read_to_string(candidate).ok();
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct ImageFile {
    #[serde(rename = "mimeType")]
    mime_type: String,
    data: String,
}

/// An image dropped on the window, base64-encoded for an ACP image block.
/// Only common image types under 10 MB; anything else is refused.
#[tauri::command]
pub fn read_image(path: String) -> Result<ImageFile, String> {
    use base64::Engine as _;
    const MAX_BYTES: u64 = 10 * 1024 * 1024;
    let path = Path::new(&path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let mime_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("not an image: {}", path.display())),
    };
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err(format!("image too large ({} MB)", size / 1024 / 1024));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(ImageFile {
        mime_type: mime_type.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Whether a path is an existing directory; lets the frontend prune stale
/// entries from its recent-projects list.
#[tauri::command]
pub fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}
