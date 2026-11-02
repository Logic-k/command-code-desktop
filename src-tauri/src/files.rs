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

/// The only files a research cycle may hold; see docs/research/research-system-design-2026-11-02.md.
const RESEARCH_FILES: &[&str] = &[
    "brief.json",
    "sources.jsonl",
    "claims.jsonl",
    "open-questions.md",
    "verify.json",
    "report.md",
    "run.json",
];
const MAX_RESEARCH_FILES: usize = 16;
const MAX_RESEARCH_BYTES: usize = 20 * 1024 * 1024;
const MAX_CYCLE_ATTEMPTS: u32 = 64;

#[derive(serde::Deserialize)]
pub struct ResearchFile {
    name: String,
    content: String,
}

/// Write one research cycle to `<cwd>/.research/<campaign>/cycle_NNN` and
/// return that directory. Each save claims a fresh cycle, never overwriting.
#[tauri::command]
pub async fn research_save(cwd: String, campaign: String, files: Vec<ResearchFile>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_research(Path::new(&cwd), &campaign, &files))
        .await
        .map_err(|e| e.to_string())?
}

fn save_research(cwd: &Path, campaign: &str, files: &[ResearchFile]) -> Result<String, String> {
    validate_campaign(campaign)?;
    validate_files(files)?;
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    let root = cwd.canonicalize().map_err(|e| format!("{}: {e}", cwd.display()))?;
    let dir = root.join(".research").join(campaign);
    // A symlink or junction at .research or the campaign could point anywhere,
    // so refuse one before creating anything through it.
    for path in [root.join(".research"), dir.clone()] {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("campaign folder escapes the project: {}", path.display()));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    let real = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    if !real.starts_with(&root) {
        return Err(format!("campaign folder escapes the project: {}", real.display()));
    }
    let cycle = claim_cycle(&real)?;
    for file in files {
        let path = cycle.join(&file.name);
        std::fs::write(&path, &file.content).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    // canonicalize adds a \\?\ prefix on Windows; report the plain path instead.
    let name = cycle.file_name().unwrap_or_default();
    let shown = std::path::absolute(cwd).map_err(|e| e.to_string())?.join(".research").join(campaign).join(name);
    Ok(shown.to_string_lossy().into_owned())
}

fn validate_campaign(campaign: &str) -> Result<(), String> {
    let invalid = || Err(format!("invalid campaign name: {campaign:?}"));
    let len = campaign.chars().count();
    if len == 0 || len > 80 || campaign == "." || campaign == ".." {
        return invalid();
    }
    if campaign.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return invalid();
    }
    if campaign.starts_with([' ', '.']) || campaign.ends_with([' ', '.']) {
        return invalid();
    }
    let stem = campaign.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        return invalid();
    }
    Ok(())
}

fn validate_files(files: &[ResearchFile]) -> Result<(), String> {
    if files.is_empty() || files.len() > MAX_RESEARCH_FILES {
        return Err(format!("expected 1 to {MAX_RESEARCH_FILES} files, got {}", files.len()));
    }
    let mut seen = std::collections::HashSet::new();
    for file in files {
        if !RESEARCH_FILES.contains(&file.name.as_str()) {
            return Err(format!("file not allowed: {:?}", file.name));
        }
        if !seen.insert(file.name.as_str()) {
            return Err(format!("duplicate file: {:?}", file.name));
        }
    }
    let total: usize = files.iter().map(|f| f.content.len()).sum();
    if total > MAX_RESEARCH_BYTES {
        return Err(format!("research files too large: {total} bytes"));
    }
    Ok(())
}

/// One past the highest `cycle_NNN` (three or more digits) in `dir`, or 1.
fn next_cycle(dir: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 1 };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let digits = name.strip_prefix("cycle_")?;
            if digits.len() < 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            digits.parse::<u32>().ok()
        })
        .max()
        .map_or(1, |n| n.saturating_add(1))
}

/// Create the next cycle directory with `create_dir`, which fails if it
/// exists, so two concurrent saves can never land in the same cycle.
fn claim_cycle(dir: &Path) -> Result<std::path::PathBuf, String> {
    let mut n = next_cycle(dir);
    for _ in 0..MAX_CYCLE_ATTEMPTS {
        let path = dir.join(format!("cycle_{n:03}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n = n.saturating_add(1),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Err(format!("could not claim a cycle folder in {}", dir.display()))
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
    use super::{claim_cycle, save_research, validate_campaign, validate_files, walk, ResearchFile};

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("cmdc-research-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn file(name: &str, content: &str) -> ResearchFile {
        ResearchFile { name: name.into(), content: content.into() }
    }

    #[test]
    fn campaign_names_reject_traversal_separators_and_devices() {
        let long = "x".repeat(81);
        for bad in [
            "", ".", "..", "../x", "a/b", "a\\b", "a:b", "a*b", "a?b", "a|b", "a\"b", "<a>", "a\u{0}b", " a", "a ",
            ".hidden", "trail.", "CON", "con", "nul.txt", "COM1", "lpt9.md", long.as_str(),
        ] {
            assert!(validate_campaign(bad).is_err(), "accepted {bad:?}");
        }
        for good in ["20261102-tauri-오프라인-저장", "research", "COM10", "console", "a.b"] {
            assert!(validate_campaign(good).is_ok(), "rejected {good:?}");
        }
    }

    #[test]
    fn research_files_reject_unknown_names_and_duplicates() {
        assert!(validate_files(&[]).is_err());
        assert!(validate_files(&[file("../brief.json", "")]).is_err());
        assert!(validate_files(&[file("notes.txt", "")]).is_err());
        assert!(validate_files(&[file("report.md", "a"), file("report.md", "b")]).is_err());
        assert!(validate_files(&[file("brief.json", "{}"), file("report.md", "# r")]).is_ok());
    }

    #[test]
    fn saves_claim_consecutive_cycles() {
        let root = temp_root("save");
        let campaign = "20261102-tauri-오프라인-저장";
        let first = save_research(&root, campaign, &[file("brief.json", "{}"), file("report.md", "# 1")]).unwrap();
        let second = save_research(&root, campaign, &[file("report.md", "# 2")]).unwrap();
        let dir = root.join(".research").join(campaign);
        let report1 = std::fs::read_to_string(dir.join("cycle_001/report.md"));
        let brief1 = dir.join("cycle_001/brief.json").is_file();
        let report2 = std::fs::read_to_string(dir.join("cycle_002/report.md"));
        let brief2 = dir.join("cycle_002/brief.json").exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(first.ends_with("cycle_001"), "{first}");
        assert!(second.ends_with("cycle_002"), "{second}");
        assert_eq!(report1.unwrap(), "# 1");
        assert!(brief1);
        assert_eq!(report2.unwrap(), "# 2");
        assert!(!brief2);
    }

    #[test]
    fn next_cycle_follows_the_highest_existing() {
        let root = temp_root("claim");
        std::fs::create_dir_all(root.join("cycle_007")).unwrap();
        std::fs::create_dir_all(root.join("cycle_x12")).unwrap();
        let claimed = claim_cycle(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert!(claimed.unwrap().ends_with("cycle_008"));
    }

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
