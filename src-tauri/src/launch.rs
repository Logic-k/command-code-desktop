//! Where the Command Code CLI lives and how to start it.
//!
//! `cmdc` on Windows is an npm shim (`cmdc.cmd`) that runs
//! `node <npm-bin>/node_modules/command-code/dist/index.mjs`. We resolve that
//! layout ourselves and spawn `node` directly, so there is no `cmd.exe` layer
//! between the app and the CLI. If resolution fails we fall back to the shim
//! through `%COMSPEC%`.

use std::path::{Path, PathBuf};

use serde::Serialize;

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
    /// The installed `command-code` version, when known.
    pub version: Option<String>,
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

/// Resolve the CLI the same way the npm shim does, without needing the shim.
pub fn resolve_launch() -> Launch {
    let shim = find_on_path("cmdc.cmd").or_else(|| find_on_path("cmdc"));
    if let Some(dir) = shim.as_deref().and_then(Path::parent) {
        let package_dir = dir.join("node_modules").join("command-code");
        let entry = package_dir.join("dist").join("index.mjs");
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
                version: package_version(&package_dir),
            };
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

/// The child environment: the whole parent environment, then our overrides.
///
/// * `profile_dir` moves the whole home (`~/.commandcode` and every other
///   home-relative config); only the add-account login uses it, so `cmd login`
///   writes into a throwaway home.
/// * `account_id` picks a saved account: its key goes in as
///   `COMMAND_CODE_API_KEY`, which the CLI prefers over `auth.json`.
pub fn child_env(profile_dir: Option<&str>, account_id: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    env.push(("CMDC_GUI".into(), "1".into()));
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
