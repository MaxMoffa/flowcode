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

/// One changed file in `git status`.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct GitChange {
    /// Repo-relative, forward slashes as git prints them.
    pub path: String,
    /// Where a rename/copy came from.
    pub orig_path: Option<String>,
    /// One of M A D R C T U ?
    pub status: String,
}

#[derive(serde::Serialize, Clone, Default, Debug)]
pub struct GitStatus {
    /// `None` when the HEAD is detached.
    pub branch: Option<String>,
    /// Short oid of HEAD; `None` in a repository without commits.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitChange>,
    pub unstaged: Vec<GitChange>,
    pub untracked: Vec<GitChange>,
    pub conflicted: Vec<GitChange>,
}

/// Counts git runs other than `status`, so `git_status` can tell its cached
/// answer may be stale.
static OTHER_RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The one place git is spawned. Returns stdout (trimmed when `trim`) on
/// success; a failure carries git's own message (stderr, or stdout when stderr
/// is empty) so the UI can show - or pattern-match - it. Environment:
/// - `GIT_TERMINAL_PROMPT=0` keeps git from blocking on a credential prompt
///   nobody can answer, and `LC_ALL=C` keeps the messages in English so
///   callers can recognise them.
/// - `GIT_LITERAL_PATHSPECS=1` so a UI path like `a[1].txt` is a file name, not
///   a glob.
/// - `GIT_OPTIONAL_LOCKS=0` so status polling never takes `index.lock` and
///   breaks a commit an agent is running at the same moment.
///
/// `core.fsmonitor=false` is forced because a hostile `.git/config` could set
/// it to a command, which git would then run on every status poll.
fn run(dir: &str, args: &[&str], input: Option<&str>, trim: bool) -> Result<String, String> {
    use std::io::Write;
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false", "-C"])
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // A write error just means git exited early; its status says why.
        let _ = stdin.write_all(input.as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    // Anything but a status read may have changed what status says.
    if args.first() != Some(&"status") {
        OTHER_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = if trim { stdout.trim().to_string() } else { stdout.to_string() };
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

/// `git -C <dir> <args>`, trimmed stdout.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    run(dir, args, None, true)
}

/// `git` without trimming the output - file contents and `-z` records must
/// come back byte for byte.
fn git_raw(dir: &str, args: &[&str]) -> Result<String, String> {
    run(dir, args, None, false)
}

/// Like `git`, but feeds `input` to git's stdin (commit messages go through
/// `-F -` so they never hit argument quoting or length limits).
fn git_with_input(dir: &str, args: &[&str], input: &str) -> Result<String, String> {
    run(dir, args, Some(input), true)
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

/// Parses `git status --porcelain=v2 --branch -z`. Records are NUL-separated;
/// a rename/copy (`2`) is followed by one extra field holding the original path.
fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus::default();
    let mut fields = out.split('\0');
    while let Some(rec) = fields.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(oid) = h.strip_prefix("branch.oid ") {
                if oid != "(initial)" {
                    st.head = Some(oid.chars().take(7).collect());
                }
            } else if let Some(b) = h.strip_prefix("branch.head ") {
                if b != "(detached)" {
                    st.branch = Some(b.to_string());
                }
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(u.to_string());
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let change = |path: &str, orig: Option<String>, status: char| GitChange {
            path: path.to_string(),
            orig_path: orig,
            status: status.to_string(),
        };
        match rec.as_bytes()[0] {
            b'?' => {
                if let Some(p) = rec.strip_prefix("? ") {
                    st.untracked.push(change(p, None, '?'));
                }
            }
            b'1' | b'2' => {
                // 1: 8 fields before the path; 2: 9 (the extra one is the rename score).
                let n = if rec.starts_with('2') { 9 } else { 8 };
                let parts: Vec<&str> = rec.splitn(n + 1, ' ').collect();
                if parts.len() <= n {
                    continue;
                }
                let orig = if rec.starts_with('2') { fields.next().map(str::to_string) } else { None };
                let mut xy = parts[1].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                if x != '.' {
                    st.staged.push(change(parts[n], orig.clone(), x));
                }
                if y != '.' {
                    st.unstaged.push(change(parts[n], orig, y));
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let parts: Vec<&str> = rec.splitn(11, ' ').collect();
                if parts.len() == 11 {
                    st.conflicted.push(change(parts[10], None, 'U'));
                }
            }
            _ => {}
        }
    }
    st
}

/// Rejects anything that isn't a plain repo-relative path: git pathspecs and
/// `rev:path` lookups must not be steerable outside the repository.
fn check_relative(path: &str) -> Result<(), String> {
    let p = path.replace('\\', "/");
    // `.git` and `.`: never a file to stage, restore or delete from the UI.
    let bad = p.is_empty()
        || p.starts_with('/')
        || p.contains(':')
        || p.split('/').any(|seg| seg == ".." || seg == "." || seg.eq_ignore_ascii_case(".git"));
    if bad {
        Err(format!("Invalid path: {path}"))
    } else {
        Ok(())
    }
}

fn check_paths(paths: &[String]) -> Result<(), String> {
    paths.iter().try_for_each(|p| check_relative(p))
}

/// Builds `<head...> -- <paths...>`.
fn with_paths<'a>(head: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args: Vec<&str> = head.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

/// The repository (main tree or linked worktree) `path` is in. Unlike
/// `git_repo_root` this is where `git status` should run.
#[tauri::command]
pub async fn git_toplevel(path: String) -> Result<Option<String>, String> {
    if unsupported(&path) {
        return Ok(None);
    }
    crate::blocking(move || Ok(git(&path, &["rev-parse", "--show-toplevel"]).ok().map(|t| native_path(&t)))).await
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    if unsupported(&root) {
        return Err("WSL folders aren't supported yet".to_string());
    }
    crate::blocking(move || {
        use std::sync::atomic::Ordering::Relaxed;
        type Slot = std::sync::Arc<std::sync::Mutex<Option<(std::time::Instant, u64, GitStatus)>>>;
        static SLOTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Slot>>> =
            std::sync::LazyLock::new(Default::default);
        // One status per repository at a time: overlapping polls wait for the
        // running one and share its answer instead of each spawning git. The
        // answer is reused for a quarter second, unless another git command ran since.
        let slot = {
            let mut slots = crate::util::lock(&SLOTS);
            match slots.get(&root) {
                Some(slot) => slot.clone(),
                None => {
                    let slot = Slot::default();
                    crate::util::insert_bounded(&mut slots, root.clone(), slot.clone());
                    slot
                }
            }
        };
        let mut last = crate::util::lock(&slot);
        let runs = OTHER_RUNS.load(Relaxed);
        if let Some((at, seen, status)) = last.as_ref() {
            if *seen == runs && at.elapsed() < std::time::Duration::from_millis(250) {
                return Ok(status.clone());
            }
        }
        // Untrimmed: `git()` would eat a trailing space of the last path.
        let out = git_raw(&root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
        let status = parse_status(&out);
        *last = Some((std::time::Instant::now(), runs, status.clone()));
        Ok(status)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    check_paths(&paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    crate::blocking(move || git(&root, &with_paths(&["add", "-A"], &paths)).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    check_paths(&paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    crate::blocking(move || {
        // Before the first commit there is no HEAD to restore from.
        if git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
            git(&root, &with_paths(&["restore", "--staged"], &paths)).map(|_| ())
        } else {
            git(&root, &with_paths(&["rm", "--cached", "-r", "-q"], &paths)).map(|_| ())
        }
    })
    .await
}

/// Commits what is staged; returns the new short hash. Failures (hooks,
/// nothing staged, no identity) carry git's own text.
#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Empty commit message".to_string());
    }
    crate::blocking(move || {
        git_with_input(&root, &["commit", "-F", "-"], &message)?;
        git(&root, &["rev-parse", "--short", "HEAD"])
    })
    .await
}

/// File content at `HEAD` or in the index (`rev` = "HEAD" | "INDEX"); empty
/// when the path doesn't exist there (a new or deleted file).
#[tauri::command]
pub async fn git_show_file(root: String, path: String, rev: String) -> Result<String, String> {
    check_relative(&path)?;
    let spec = match rev.as_str() {
        "HEAD" => format!("HEAD:{path}"),
        "INDEX" => format!(":{path}"),
        _ => return Err(format!("Unknown revision: {rev}")),
    };
    crate::blocking(move || {
        // `cat-file -e` tells "absent" apart from a real failure.
        if git(&root, &["cat-file", "-e", &spec]).is_err() {
            return Ok(String::new());
        }
        // No textconv: a repo-configured converter is a command we'd be running.
        git_raw(&root, &["show", "--no-textconv", &spec])
    })
    .await
}

/// One branch in the switcher.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct GitBranch {
    /// Short name; `origin/feature` for a remote one.
    pub name: String,
    /// What a local branch tracks (`origin/feature`).
    pub upstream: Option<String>,
    pub last_commit_unix: Option<i64>,
}

#[derive(serde::Serialize, Default, Debug)]
pub struct GitBranches {
    /// `None` when the HEAD is detached.
    pub current: Option<String>,
    /// Most recently committed first.
    pub local: Vec<GitBranch>,
    /// Without the ones a local branch already tracks, most recent first.
    pub remote: Vec<GitBranch>,
}

/// Parses `for-each-ref` records of `refname \x1f short \x1f upstream \x1f unix`.
fn parse_branches(out: &str, current: Option<String>) -> GitBranches {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in out.lines() {
        let mut f = line.split('\x1f');
        let (Some(full), Some(short), Some(upstream), Some(unix)) = (f.next(), f.next(), f.next(), f.next()) else {
            continue;
        };
        let branch = GitBranch {
            name: short.to_string(),
            upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            last_commit_unix: unix.parse().ok(),
        };
        if full.starts_with("refs/heads/") {
            local.push(branch);
        } else if full.starts_with("refs/remotes/") && !short.ends_with("/HEAD") && short.contains('/') {
            remote.push(branch);
        }
    }
    let tracked: std::collections::HashSet<&str> = local.iter().filter_map(|b| b.upstream.as_deref()).collect();
    remote.retain(|b| !tracked.contains(b.name.as_str()));
    // Stable: branches without a date (empty repo) keep git's alphabetical order.
    local.sort_by_key(|b| std::cmp::Reverse(b.last_commit_unix));
    remote.sort_by_key(|b| std::cmp::Reverse(b.last_commit_unix));
    GitBranches { current, local, remote }
}

/// A name `git switch` can be handed safely: no option look-alike, no
/// whitespace or control characters, and a valid ref name (which also refuses
/// `@{-1}`-style shortcuts and `..`).
fn check_branch_name(root: &str, name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('-')
        || name.starts_with('@')
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("Invalid branch name: {name}"));
    }
    git(root, &["check-ref-format", "--branch", name]).map(|_| ()).map_err(|_| format!("Invalid branch name: {name}"))
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<GitBranches, String> {
    if unsupported(&root) {
        return Err("WSL folders aren't supported yet".to_string());
    }
    crate::blocking(move || {
        // Works on an unborn branch too; fails (-> None) on a detached HEAD.
        let current = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
        let out = git_raw(
            &root,
            &[
                "for-each-ref",
                "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:unix)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        Ok(parse_branches(&out, current))
    })
    .await
}

/// Switches branch. `name` is a local branch, or - with `create_from_remote` -
/// a `<remote>/<branch>` one, for which git creates the local tracking branch.
/// git refusing (changes that would be overwritten, ...) comes back verbatim.
/// Like every non-status git run it invalidates the cached `git_status`.
#[tauri::command]
pub async fn git_switch_branch(root: String, name: String, create_from_remote: bool) -> Result<(), String> {
    if unsupported(&root) {
        return Err("WSL folders aren't supported yet".to_string());
    }
    crate::blocking(move || {
        check_branch_name(&root, &name)?;
        // A remote branch whose short name is already a local branch (one that
        // doesn't track it) can't be created again: switch to the local one.
        let local = create_from_remote
            .then(|| name.split_once('/').map(|(_, short)| short))
            .flatten()
            .filter(|short| {
                git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{short}")]).is_ok()
            });
        let args: &[&str] = if let Some(short) = local {
            &["switch", "--no-guess", short]
        } else if create_from_remote {
            &["switch", "--track", &name]
        } else {
            &["switch", "--no-guess", &name]
        };
        git(&root, args).map(|_| ())
    })
    .await
}

/// Throws away working-tree changes. Tracked files are restored from the
/// index; untracked ones are deleted (only if they resolve inside `root`).
#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    check_paths(&paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    crate::blocking(move || {
        if !untracked {
            return git(&root, &with_paths(&["restore", "--worktree"], &paths)).map(|_| ());
        }
        let base = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        for p in &paths {
            let target = base.join(p);
            // Canonicalise the parent so a symlinked directory can't lead outside.
            let parent = target.parent().ok_or_else(|| format!("Invalid path: {p}"))?;
            let Ok(resolved) = std::fs::canonicalize(parent) else { continue };
            if !resolved.starts_with(&base) {
                return Err(format!("Path is outside the repository: {p}"));
            }
            let Ok(meta) = std::fs::symlink_metadata(&target) else { continue };
            if meta.is_dir() {
                std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
            } else if let Err(e) = std::fs::remove_file(&target) {
                // A directory symlink on Windows is removed as a directory
                // entry - the link itself, never what it points to.
                if !meta.file_type().is_symlink() || std::fs::remove_dir(&target).is_err() {
                    return Err(e.to_string());
                }
            }
        }
        Ok(())
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
        let Some(target) = target else {
            return Err("That path isn't a worktree of this repository".to_string());
        };
        if target.is_main {
            return Err("That's the main working tree".to_string());
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push("--");
        args.push(&path);
        git(&repo_root, &args)?;

        let mut branch_kept = None;
        if let Some(branch) = target.branch.filter(|b| b.starts_with(BRANCH_PREFIX)) {
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
    fn rejects_unsafe_branch_names() {
        // These fail before git is ever spawned.
        for bad in ["", "-f", "--detach", "@{-1}", "a b", "a\tb", "a\nb", "x\u{7}"] {
            assert!(check_branch_name(".", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn parses_branches() {
        let sample = "refs/heads/main\x1fmain\x1forigin/main\x1f200\n\
                      refs/heads/old\x1fold\x1f\x1f100\n\
                      refs/heads/new\x1fnew\x1f\x1f300\n\
                      refs/remotes/origin/HEAD\x1forigin\x1f\x1f200\n\
                      refs/remotes/origin/main\x1forigin/main\x1f\x1f200\n\
                      refs/remotes/origin/feat\x1forigin/feat\x1f\x1f250\n";
        let b = parse_branches(sample, Some("main".into()));
        let local: Vec<_> = b.local.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(local, ["new", "main", "old"]);
        assert_eq!(b.local[1].upstream.as_deref(), Some("origin/main"));
        let remote: Vec<_> = b.remote.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(remote, ["origin/feat"]);
        assert_eq!(b.current.as_deref(), Some("main"));
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

    #[test]
    fn parses_status() {
        let out = "# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 MM N... 100644 100644 100644 aaa bbb src/a.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new name.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.rs\0\
? notes.txt\0";
        let st = parse_status(out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_deref(), Some("1234567"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.staged.len(), 2);
        assert_eq!(st.staged[0].path, "src/a.rs");
        assert_eq!(st.staged[0].status, "M");
        assert_eq!(st.staged[1].status, "R");
        assert_eq!(st.staged[1].path, "new name.rs");
        assert_eq!(st.staged[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(st.unstaged.len(), 1);
        assert_eq!(st.unstaged[0].status, "M");
        assert_eq!(st.conflicted[0].path, "conflict.rs");
        assert_eq!(st.untracked[0].path, "notes.txt");
        assert_eq!(st.untracked[0].status, "?");
    }

    #[test]
    fn parses_detached_head() {
        let st = parse_status("# branch.oid abcdef1234\0# branch.head (detached)\0");
        assert!(st.branch.is_none());
        assert_eq!(st.head.as_deref(), Some("abcdef1"));
        assert!(st.upstream.is_none());
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(check_relative("src/a.rs").is_ok());
        assert!(check_relative("../x").is_err());
        assert!(check_relative("a/../x").is_err());
        assert!(check_relative("/etc/passwd").is_err());
        assert!(check_relative("C:\\x").is_err());
    }
}
