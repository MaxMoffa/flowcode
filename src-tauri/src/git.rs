use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

/// Prefix of the branches Flowcode creates for agent worktrees. It is what
/// tells "ours" apart from worktrees the user made by hand, so removal only
/// ever deletes a branch carrying it.
const BRANCH_PREFIX: &str = "flowcode/";

/// One working tree of a repository, as `git worktree list` reports it.
#[derive(serde::Serialize, Clone)]
pub struct GitWorktree {
    /// Native separators - git prints `C:/Users/...` on Windows.
    pub path: String,
    /// Short branch name; `None` when the HEAD is detached.
    pub branch: Option<String>,
    pub head: String,
    /// The repository's main working tree (first entry of the list).
    pub is_main: bool,
    /// Created by Flowcode: the branch starts with `flowcode/`.
    pub flowcode: bool,
}

#[derive(serde::Serialize)]
pub struct WorktreeRemoval {
    /// The branch left in place because it has commits not merged anywhere
    /// (`git branch -d` refused). We never force-delete: those commits would
    /// become unreachable.
    pub branch_kept: Option<String>,
}

/// Runs `git -C <dir> <args>` and returns its trimmed stdout. A failure carries
/// git's own message (stderr, or stdout when stderr is empty) so the UI can show
/// - or pattern-match - it. `GIT_TERMINAL_PROMPT=0` keeps git from blocking on
/// a credential prompt nobody can answer, and `LC_ALL=C` keeps the messages in
/// English so callers can recognise them.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

/// git prints forward slashes even on Windows; the frontend compares paths
/// with the backslashed ones it gets everywhere else.
fn native_path(p: &str) -> String {
    if cfg!(windows) {
        p.replace('/', "\\")
    } else {
        p.to_string()
    }
}

/// Worktree support is host-only for now: a WSL share would need git run inside
/// the distro, and on Windows a POSIX path can only be a WSL-side path.
fn unsupported(path: &str) -> bool {
    let lower = path.replace('/', "\\").to_lowercase();
    if lower.starts_with("\\\\wsl.localhost\\") || lower.starts_with("\\\\wsl$\\") {
        return true;
    }
    cfg!(windows) && path.starts_with('/')
}

/// Path form used only to compare two paths: native separators, no trailing
/// separator, and case-insensitive on Windows.
fn comparable(p: &str) -> String {
    let n = native_path(p);
    let n = n.trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        n.to_lowercase()
    } else {
        n.to_string()
    }
}

/// Parses `git worktree list --porcelain`: blocks separated by blank lines.
/// Bare and prunable (directory gone) entries are skipped, since neither can
/// host an agent; the first remaining entry is the main working tree.
fn parse_worktrees(porcelain: &str) -> Vec<GitWorktree> {
    #[derive(Default)]
    struct Block {
        path: Option<String>,
        head: String,
        branch: Option<String>,
        skip: bool,
    }

    fn flush(block: Block, out: &mut Vec<GitWorktree>) {
        let Some(path) = block.path else { return };
        if block.skip {
            return;
        }
        let flowcode = block.branch.as_deref().is_some_and(|b| b.starts_with(BRANCH_PREFIX));
        out.push(GitWorktree {
            path: native_path(&path),
            branch: block.branch,
            head: block.head,
            is_main: out.is_empty(),
            flowcode,
        });
    }

    let mut out = Vec::new();
    let mut block = Block::default();
    for line in porcelain.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(std::mem::take(&mut block), &mut out);
        } else if let Some(p) = line.strip_prefix("worktree ") {
            block.path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            block.head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            block.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" || line == "prunable" || line.starts_with("prunable ") {
            block.skip = true;
        }
    }
    flush(block, &mut out);
    out
}

fn list_worktrees(repo_root: &str) -> Result<Vec<GitWorktree>, String> {
    Ok(parse_worktrees(&git(repo_root, &["worktree", "list", "--porcelain"])?))
}

/// Folder-name-safe version of the agent label: `[a-z0-9-]`, no repeated or
/// edge dashes, capped, plus a random suffix so two agents with the same label
/// never collide on the directory or the branch.
fn slugify(label: &str) -> String {
    let mut slug = String::new();
    for c in label.to_lowercase().chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' };
        if c == '-' && slug.ends_with('-') {
            continue;
        }
        slug.push(c);
    }
    let mut slug: String = slug.trim_matches('-').chars().take(24).collect();
    slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        slug = "agent".to_string();
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{slug}-{}", &id[..6])
}

/// The main working tree of the repository `path` is in. Run from inside a
/// linked worktree, `--show-toplevel` would return that worktree, so the main
/// one is derived from the shared git dir (`<main>/.git`) instead. `None` when
/// `path` isn't in a repository (or git isn't installed): that's not an error,
/// the UI just hides the worktree option.
#[tauri::command]
pub async fn git_repo_root(path: String) -> Result<Option<String>, String> {
    if unsupported(&path) {
        return Ok(None);
    }
    crate::blocking(move || {
        let Ok(toplevel) = git(&path, &["rev-parse", "--show-toplevel"]) else {
            return Ok(None);
        };
        let common = git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok();
        let main = common
            .as_deref()
            .map(Path::new)
            .filter(|dir| dir.file_name().is_some_and(|n| n == ".git"))
            .and_then(|dir| dir.parent())
            .map(|p| p.to_string_lossy().to_string())
            // A bare repository has no `<main>/.git`: the toplevel is all there is.
            .unwrap_or(toplevel);
        Ok(Some(native_path(&main)))
    })
    .await
}

#[tauri::command]
pub async fn git_worktrees(repo_root: String) -> Result<Vec<GitWorktree>, String> {
    if unsupported(&repo_root) {
        return Ok(vec![]);
    }
    crate::blocking(move || list_worktrees(&repo_root)).await
}

/// Creates a worktree on a fresh `flowcode/<slug>` branch off the main
/// checkout's current HEAD. It lives in a `<repo>.worktrees` folder *next to*
/// the repository rather than inside it, so an agent working in the main
/// checkout never sees (or indexes, or greps through) the other agents' trees.
#[tauri::command]
pub async fn git_worktree_add(repo_root: String, label: String) -> Result<GitWorktree, String> {
    if unsupported(&repo_root) {
        return Err("WSL folders aren't supported yet".to_string());
    }
    crate::blocking(move || {
        let slug = slugify(&label);
        let root = Path::new(&repo_root);
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| "Can't locate the repository folder".to_string())?;
        let parent = root.parent().ok_or_else(|| "Can't locate the repository folder".to_string())?;
        let container = parent.join(format!("{name}.worktrees"));
        std::fs::create_dir_all(&container).map_err(|e| e.to_string())?;
        let target = container.join(&slug);
        let target_str = target.to_string_lossy().to_string();
        let branch = format!("{BRANCH_PREFIX}{slug}");
        git(&repo_root, &["worktree", "add", "-b", &branch, &target_str])?;
        let head = git(&target_str, &["rev-parse", "HEAD"])?;
        Ok(GitWorktree {
            path: native_path(&target_str),
            branch: Some(branch),
            head,
            is_main: false,
            flowcode: true,
        })
    })
    .await
}

/// Removes a worktree and, if Flowcode created its branch, the branch too - but
/// only when `git branch -d` agrees it is fully merged. An unmerged branch is
/// reported back instead of deleted so the agent's commits aren't lost. A
/// worktree with local changes makes git refuse unless `force` is set; that
/// message is passed through untouched for the UI to recognise.
#[tauri::command]
pub async fn git_worktree_remove(
    repo_root: String,
    path: String,
    force: bool,
) -> Result<WorktreeRemoval, String> {
    if unsupported(&repo_root) || unsupported(&path) {
        return Err("WSL folders aren't supported yet".to_string());
    }
    crate::blocking(move || {
        let wanted = comparable(&path);
        let target = list_worktrees(&repo_root)?
            .into_iter()
            .find(|w| comparable(&w.path) == wanted);
        if target.as_ref().is_some_and(|w| w.is_main) {
            return Err("That's the main working tree".to_string());
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path);
        git(&repo_root, &args)?;

        let mut branch_kept = None;
        if let Some(branch) = target.and_then(|w| w.branch).filter(|b| b.starts_with(BRANCH_PREFIX)) {
            if git(&repo_root, &["branch", "-d", &branch]).is_err() {
                branch_kept = Some(branch);
            }
        }
        let _ = git(&repo_root, &["worktree", "prune"]);
        Ok(WorktreeRemoval { branch_kept })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_list() {
        let sample = "worktree C:/dev/app\nHEAD aaa111\nbranch refs/heads/main\n\n\
                      worktree C:/dev/app.worktrees/x-1a2b3c\nHEAD bbb222\nbranch refs/heads/flowcode/x-1a2b3c\n\n\
                      worktree C:/dev/app.worktrees/det\nHEAD ccc333\ndetached\n\n\
                      worktree C:/dev/app.worktrees/gone\nHEAD ddd444\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n";
        let list = parse_worktrees(sample);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main && !list[0].flowcode);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch.as_deref(), Some("flowcode/x-1a2b3c"));
        assert!(list[1].flowcode && !list[1].is_main);
        assert_eq!(list[1].head, "bbb222");
        assert!(list[2].branch.is_none() && !list[2].flowcode);
        if cfg!(windows) {
            assert_eq!(list[0].path, "C:\\dev\\app");
        }
    }

    #[test]
    fn slug_and_unsupported() {
        let s = slugify("  Claude Code!! #1 ");
        assert!(s.starts_with("claude-code-1-") && s.len() == "claude-code-1-".len() + 6, "{s}");
        assert!(slugify("???").starts_with("agent-"));
        assert!(unsupported("\\\\wsl.localhost\\Ubuntu\\home"));
        assert!(unsupported("//WSL$/Ubuntu/home"));
        assert!(!unsupported("C:\\dev"));
    }
}
