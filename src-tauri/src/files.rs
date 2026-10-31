//! Files: project paths for the composer's `@` mentions (relative paths only,
//! never contents; git's own list when the folder is a repository, since it
//! already knows what is ignored, otherwise a bounded walk that skips
//! dependency and build folders), and saving exports where the user picks.

use std::path::Path;
use std::process::{Command, Stdio};

/// Enough for any project a person picks files from by name.
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out", "__pycache__", "venv"];

#[tauri::command]
pub async fn list_files(cwd: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&cwd).to_path_buf();
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || git_files(&dir).unwrap_or_else(|| walk(&dir)))
        .await
        .map_err(|e| e.to_string())
}

/// Ask where to save `content` (starting in Downloads as `name`) and write it.
/// `None` when the user cancels. A webview `<a download>` has no reliable
/// save behavior across WebView2 and WKWebView; a native dialog does.
#[tauri::command]
pub async fn save_text_file(app: tauri::AppHandle, name: String, content: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&name);
        if let Ok(downloads) = app.path().download_dir() {
            dialog = dialog.set_directory(downloads);
        }
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn git_files(dir: &Path) -> Option<Vec<String>> {
    let output = crate::procs::background(
        Command::new("git")
            .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .current_dir(dir)
            .stdin(Stdio::null())
            .stderr(Stdio::null()),
    )
    .output()
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        output
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .take(MAX_FILES)
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
    )
}

/// Breadth-first, so a huge subtree cannot crowd out the top-level files.
fn walk(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back((entry.path(), depth + 1));
                }
            } else if kind.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    files.push(rel.to_string_lossy().replace('\\', "/"));
                    if files.len() >= MAX_FILES {
                        return files;
                    }
                }
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::walk;

    #[test]
    fn walk_skips_hidden_and_dependency_folders() {
        let root = std::env::temp_dir().join(format!("cmdc-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["src/ui", "node_modules/pkg", ".git"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["README.md", "src/main.ts", "src/ui/dom.ts", "node_modules/pkg/index.js", ".git/HEAD", ".env"] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        let files = walk(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(files, ["README.md", "src/main.ts", "src/ui/dom.ts"]);
    }
}
