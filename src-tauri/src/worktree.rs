//! Isolated git worktrees for unattended workflow runs.
//!
//! A `build`/`taste` run may edit files while the user is away. Running it in
//! a scratch worktree (a separate checkout on its own branch) keeps the
//! user's working copy untouched; afterwards the Changes panel lists what the
//! run changed so nothing merges silently.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    crate::procs::background(&mut cmd);
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn repo_root(dir: &Path) -> Result<PathBuf, String> {
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(top.trim()))
}

fn slug(text: &str) -> String {
    let mut s: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    s.trim_matches('-').chars().take(32).collect()
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    /// The new checkout the run should use as its cwd.
    path: String,
    /// The repo the worktree belongs to (needed for removal).
    root: String,
    branch: String,
}

/// `git worktree add` a scratch checkout under the app's data dir.
#[tauri::command]
pub fn worktree_create(app: AppHandle, root: String, name: Option<String>) -> Result<WorktreeInfo, String> {
    let root = repo_root(Path::new(&root))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let branch = format!("ccd-{}{}", slug(name.as_deref().unwrap_or("run")), stamp % 1_000_000);
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&branch);
    git(&root, &["worktree", "add", "--force", "-b", &branch, &path.to_string_lossy(), "HEAD"])
        .map_err(|e| format!("git worktree add 실패: {e}"))?;
    Ok(WorktreeInfo { path: path.to_string_lossy().into_owned(), root: root.to_string_lossy().into_owned(), branch })
}

#[derive(Serialize)]
pub struct ChangedFile {
    path: String,
    /// A(dded) M(odified) D(eleted) — staged or unstaged alike.
    status: String,
    added: Option<u32>,
    deleted: Option<u32>,
}

#[derive(Serialize)]
pub struct WorktreeChanges {
    branch: String,
    files: Vec<ChangedFile>,
}

/// Status + line counts of everything the run changed in its worktree.
#[tauri::command]
pub fn worktree_changes(path: String) -> Result<WorktreeChanges, String> {
    let dir = Path::new(&path);
    let branch = git(dir, &["branch", "--show-current"])?.trim().to_string();
    let porcelain = git(dir, &["status", "--porcelain=v1"])?;
    let mut files: Vec<ChangedFile> = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().chars().next().unwrap_or('M').to_string();
        let file = line[3..].rsplit(" -> ").next().unwrap_or("").trim_matches('"').to_string();
        if !file.is_empty() {
            files.push(ChangedFile { path: file, status, added: None, deleted: None });
        }
    }
    // Line counts for tracked changes; untracked files get counted by reading.
    if let Ok(numstat) = git(dir, &["diff", "HEAD", "--numstat"]) {
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            if let (Some(a), Some(d), Some(p)) = (cols.next(), cols.next(), cols.next()) {
                if let Some(f) = files.iter_mut().find(|f| f.path == p || p.ends_with(&f.path) || f.path.ends_with(p)) {
                    f.added = a.parse().ok();
                    f.deleted = d.parse().ok();
                }
            }
        }
    }
    Ok(WorktreeChanges { branch, files })
}

/// Old/new text of one changed file, for the app's own diff renderer.
#[tauri::command]
pub fn worktree_file_diff(path: String, file: String) -> Result<(Option<String>, String), String> {
    let dir = Path::new(&path);
    let old = git(dir, &["show", &format!("HEAD:{file}")]).ok().filter(|_| dir.join(&file).is_file() || true);
    let new = std::fs::read_to_string(dir.join(&file)).unwrap_or_default();
    Ok((old, new))
}

/// Drop the scratch worktree (the branch stays in the repo's refs).
#[tauri::command]
pub fn worktree_remove(root: String, path: String) -> Result<(), String> {
    git(Path::new(&root), &["worktree", "remove", "--force", &path]).map(|_| ())
}
