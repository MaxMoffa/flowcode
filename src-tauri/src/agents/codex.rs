//! Codex CLI side of agent discovery: rollout files, thread names and the
//! recent-sessions list (host and WSL).

use super::*;

/// Whether the rollout's last turn is still open: its latest `task_started`
/// has no `task_complete` / `turn_aborted` after it. Codex writes nothing
/// while a command runs or an approval waits on the user, so how recently
/// the file changed can't tell a long step from a finished turn - these
/// events can. Read backwards from the end, and only again once the file
/// has grown.
pub(super) fn rollout_turn_open(path: &Path) -> Option<bool> {
    const CHUNK: u64 = 64 * 1024;
    /// A turn's output can be long; past this, give up and let the caller
    /// fall back to the file's mtime.
    const MAX_SCAN: u64 = 4 * 1024 * 1024;
    /// Path -> (file length when read, answer).
    type TurnCache = HashMap<PathBuf, (u64, Option<bool>)>;
    static CACHE: LazyLock<Mutex<TurnCache>> = LazyLock::new(Default::default);

    let len = std::fs::metadata(path).ok()?.len();
    if let Some((at, open)) = lock(&CACHE).get(path) {
        if *at == len {
            return *open;
        }
    }
    let open = scan_lines_backwards(path, CHUNK, MAX_SCAN, |line| {
        // Escaped inside any message text, so only a real event's own
        // payload matches.
        let has = |needle: &[u8]| has_bytes(line, needle);
        if has(br#"{"type":"task_started""#) {
            return Some(true);
        }
        if has(br#"{"type":"task_complete""#) || has(br#"{"type":"turn_aborted""#) {
            return Some(false);
        }
        None
    });
    insert_bounded(&mut lock(&CACHE), path.to_path_buf(), (len, open));
    open
}

/// What a rollout's `session_meta` says - read once per file (it never
/// changes), since live threads are looked up on every poll.
#[derive(Clone)]
pub(super) struct RolloutMeta {
    pub(super) id: String,
    pub(super) cwd: String,
    pub(super) subagent: bool,
}

pub(super) fn rollout_meta(path: &Path) -> Option<RolloutMeta> {
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, Option<RolloutMeta>>>> = LazyLock::new(Default::default);
    if let Some(hit) = lock(&CACHE).get(path) {
        return hit.clone();
    }
    // The outer `None`: the first line couldn't be read (a rollout Codex has
    // only just created) - not cached, so it is looked at again. The inner
    // one: read, but not a `session_meta` shape - final.
    let meta: Option<Option<RolloutMeta>> = (|| {
        let file = std::fs::File::open(path).ok()?;
        let line = BufReader::new(file).lines().next()?.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        Some((|| {
            let payload = value.get("payload")?;
            Some(RolloutMeta {
                id: payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| uuid_from_filename(path))?,
                cwd: payload.get("cwd")?.as_str()?.to_string(),
                subagent: payload.get("parent_thread_id").is_some_and(|p| !p.is_null())
                    || payload.get("source").and_then(|s| s.get("subagent")).is_some(),
            })
        })())
    })();
    let meta = meta?;
    insert_bounded(&mut lock(&CACHE), path.to_path_buf(), meta.clone());
    meta
}

/// Thread names from a Codex home's `session_index.jsonl` - re-read only
/// when the file changes.
pub(super) fn thread_names_in(codex_home: &Path) -> HashMap<String, String> {
    type NameCache = HashMap<PathBuf, (Option<u64>, HashMap<String, String>)>;
    static CACHE: LazyLock<Mutex<NameCache>> = LazyLock::new(Default::default);
    let index = codex_home.join("session_index.jsonl");
    let mtime = crate::fs::system_time_to_millis(std::fs::metadata(&index).and_then(|m| m.modified()));
    let mut cache = lock(&CACHE);
    if let Some((at, names)) = cache.get(&index) {
        if *at == mtime {
            return names.clone();
        }
    }
    let names = codex_thread_names(&codex_home.join("sessions"));
    cache.insert(index, (mtime, names.clone()));
    names
}

/// Whether another process holds `lock` - how Codex marks the threads it
/// has open (`~/.codex/thread-writer-locks/<id>.lock`). Tried shared and
/// released at once, so it never stands in Codex's way.
pub(super) fn lock_is_held(lock: &Path) -> bool {
    let file = match std::fs::OpenOptions::new().read(true).open(lock) {
        Ok(file) => file,
        // Windows: opened without sharing by its holder.
        Err(e) => return e.raw_os_error() == Some(32),
    };
    match file.try_lock_shared() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(_) => false,
    }
}

/// Codex threads open right now on this machine itself (not in WSL), in the
/// Codex home of every profile: those whose writer lock is held.
pub(super) fn host_live_threads(homes: &[(Option<String>, PathBuf)]) -> Vec<LiveThread> {
    homes.iter().flat_map(|(profile, home)| host_live_threads_in(home, profile)).collect()
}

pub(super) fn host_live_threads_in(home: &Path, profile: &Option<String>) -> Vec<LiveThread> {
    let Ok(locks) = std::fs::read_dir(home.join("thread-writer-locks")) else { return Vec::new() };
    let held: Vec<String> = locks
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "lock")
                && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
        })
        .filter(|p| lock_is_held(p))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    if held.is_empty() {
        return Vec::new();
    }
    let sessions = home.join("sessions");
    let names = thread_names_in(home);
    held.iter()
        .filter_map(|id| {
            let path = &find_codex_rollout(&sessions, id)?;
            let meta = rollout_meta(path)?;
            if meta.subagent {
                return None;
            }
            Some(LiveThread {
                name: names.get(&meta.id).cloned(),
                id: meta.id,
                cwd: meta.cwd,
                updated_at: crate::fs::system_time_to_millis(std::fs::metadata(path).and_then(|m| m.modified())),
                turn_open: rollout_turn_open(path),
                wsl_distro: None,
                pty_id: None,
                profile: profile.clone(),
            })
        })
        .collect()
}

/// One saved Codex CLI session, read directly off disk. Codex CLI has no
/// `claude agents --json` equivalent - no daemon, no registry of which
/// sessions are currently alive - only a transcript per session under
/// `~/.codex/sessions`. So this can only ever offer "sessions that exist to
/// resume", not "sessions currently running elsewhere" (`list_agent_sessions`
/// above already covers the one case that's actually knowable: a codex
/// process running inside one of this app's own tabs).
///
/// The on-disk layout is undocumented and has shifted across Codex versions
/// (flat vs. nested by year/month/day) - everything here is best-effort:
/// any file, or any single record inside a file, that doesn't parse the way
/// expected is just skipped rather than surfaced as an error, exactly like
/// `list_claude_agents`'s own "not installed / old version" fallback above.
#[derive(Serialize, Clone)]
pub struct CodexSessionEntry {
    pub(super) cwd: String,
    #[serde(rename = "sessionId")]
    pub(super) session_id: String,
    /// The rollout file's own mtime - not a field read out of its content,
    /// which would need trusting a timestamp format that isn't documented
    /// either. Good enough for "how long ago" sorting/display.
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    /// Set for a session saved by Codex inside WSL: resuming it means a WSL
    /// tab in that distro, and `cwd` is a Linux path.
    #[serde(rename = "wslDistro")]
    pub(super) wsl_distro: Option<String>,
    /// The thread's title in Codex (the one it generated, or the name the
    /// user gave it) - see `codex_thread_names`.
    name: Option<String>,
    /// Open right now in some terminal (see `LiveThread`) - not just saved.
    /// `startedAt` is then when it last wrote, `status` "busy"/"idle".
    live: bool,
    status: Option<String>,
    /// Running in a Flowcode tab (this app's or another instance's).
    #[serde(rename = "inFlowcode")]
    in_flowcode: bool,
    /// The account profile whose Codex home holds it (`None`: the default
    /// profile, and anything found in WSL).
    profile: Option<String>,
}

/// Thread id -> its current name, from Codex's `session_index.jsonl` next to
/// the sessions folder: one line per naming, oldest first, so a thread's
/// latest line (a rename included) wins.
pub(super) fn codex_thread_names(sessions_root: &Path) -> HashMap<String, String> {
    let Some(index) = sessions_root.parent().map(|home| home.join("session_index.jsonl")) else {
        return HashMap::new();
    };
    let Ok(file) = std::fs::File::open(index) else { return HashMap::new() };
    let mut names = HashMap::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let (Some(id), Some(name)) = (
            value.get("id").and_then(|v| v.as_str()),
            value.get("thread_name").and_then(|v| v.as_str()),
        ) {
            names.insert(id.to_string(), name.to_string());
        }
    }
    names
}

/// Max sessions listed in the sidebar - a project with years of history
/// shouldn't dump its entire archive there, just what's plausibly worth
/// resuming.
pub(super) const MAX_CODEX_SESSIONS: usize = 8;

pub(super) fn is_rollout_name(name: &str) -> bool {
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// The entries of `dir` by name, descending: Codex lays sessions out as
/// `YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, so that is newest first.
pub(super) fn entries_newest_first(dir: &Path) -> Vec<std::fs::DirEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    entries
}

/// Collects `rollout-*.jsonl` files under `dir`, newest first (see
/// `entries_newest_first`), and stops once `limit` are found - a history of
/// years is never walked past what's wanted. Bounded depth rather than a
/// hardcoded year/month/day nesting, so it survives either layout. Archived
/// sessions (`.jsonl.zst`, zstd-compressed) are skipped: there's no
/// decompression dependency here, and archived history isn't worth pulling
/// into a live sidebar anyway.
pub(super) fn find_recent_rollouts(dir: &Path, depth: u8, limit: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    for entry in entries_newest_first(dir) {
        if out.len() >= limit {
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            find_recent_rollouts(&entry.path(), depth - 1, limit, out);
        } else if entry.file_name().to_str().is_some_and(is_rollout_name) {
            out.push(entry.path());
        }
    }
}

/// The rollout of thread `id` under a Codex `sessions` folder
/// (`rollout-<timestamp>-<id>.jsonl`), found newest day first - a thread being
/// asked about is almost always recent. A found path is remembered (a
/// rollout doesn't move), and a miss for a few seconds, since the agents poll
/// asks again every couple of seconds.
pub(crate) fn find_codex_rollout(sessions: &Path, id: &str) -> Option<PathBuf> {
    const MISS_TTL: std::time::Duration = std::time::Duration::from_secs(5);
    type Key = (PathBuf, String);
    static FOUND: LazyLock<Mutex<HashMap<Key, PathBuf>>> = LazyLock::new(Default::default);
    static MISSED: LazyLock<Mutex<HashMap<Key, std::time::Instant>>> = LazyLock::new(Default::default);

    fn walk(dir: &Path, suffix: &str, depth: u8) -> Option<PathBuf> {
        if depth == 0 {
            return None;
        }
        for entry in entries_newest_first(dir) {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if let Some(found) = walk(&entry.path(), suffix, depth - 1) {
                    return Some(found);
                }
            } else if entry.file_name().to_str().is_some_and(|n| is_rollout_name(n) && n.ends_with(suffix)) {
                return Some(entry.path());
            }
        }
        None
    }

    let key = (sessions.to_path_buf(), id.to_string());
    if let Some(path) = lock(&FOUND).get(&key).filter(|p| p.is_file()) {
        return Some(path.clone());
    }
    if lock(&MISSED).get(&key).is_some_and(|at| at.elapsed() < MISS_TTL) {
        return None;
    }
    match walk(sessions, &format!("-{id}.jsonl"), 4) {
        Some(path) => {
            insert_bounded(&mut lock(&FOUND), key, path.clone());
            Some(path)
        }
        None => {
            insert_bounded(&mut lock(&MISSED), key, std::time::Instant::now());
            None
        }
    }
}

/// Depth-first search through a parsed JSON value for the first string
/// found under a key named `key`, anywhere in the tree - the rollout
/// envelope's exact nesting isn't documented, so this doesn't assume one.
pub(super) fn find_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            map.values().find_map(|v| find_string_field(v, key))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_string_field(v, key)),
        _ => None,
    }
}

/// The uuid embedded in a rollout filename itself
/// (`rollout-2025-10-07T12-34-56-<uuid>.jsonl`) - the fallback session id
/// when the content's own id field isn't where expected, since `codex
/// resume` accepts this same id either way.
pub(super) fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('-').collect();
    (0..parts.len())
        .map(|start| parts[start..].join("-"))
        .find(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
}

/// Reads just enough of a rollout file (its first handful of lines) to
/// recover the session's cwd and id - never the whole transcript, which can
/// be an arbitrarily long conversation.
pub(super) fn read_codex_session(
    path: &Path,
    started_at: Option<u64>,
    wsl_distro: Option<&str>,
    profile: Option<&str>,
) -> Option<CodexSessionEntry> {
    let entry = |cwd: String, session_id: String| CodexSessionEntry {
        cwd,
        session_id,
        started_at,
        wsl_distro: wsl_distro.map(str::to_string),
        name: None,
        live: false,
        status: None,
        in_flowcode: false,
        profile: profile.map(str::to_string),
    };
    // Current Codex: the first record is `session_meta`, whose `id` is the
    // thread `codex resume` takes (its `session_id` can name another thread).
    // Sub-agent threads (a reviewer, a spawned helper) have one too, with a
    // parent - not something to resume on its own.
    if let Some(meta) = rollout_meta(path) {
        return if meta.subagent { None } else { Some(entry(meta.cwd, meta.id)) };
    }
    // Older layouts: no `session_meta` envelope - best-effort search.
    let reader = BufReader::new(std::fs::File::open(path).ok()?);
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    for line in reader.lines().take(20).filter_map(|l| l.ok()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = find_string_field(&value, "cwd");
        }
        if session_id.is_none() {
            session_id = find_string_field(&value, "session_id").or_else(|| find_string_field(&value, "id"));
        }
        if cwd.is_some() && session_id.is_some() {
            break;
        }
    }
    let session_id = session_id.or_else(|| uuid_from_filename(path))?;
    Some(entry(cwd?, session_id))
}

/// Async + blocking pool: walks and opens files under `~/.codex/sessions`
/// (Windows' own, and the default WSL distro's) on every sidebar poll.
#[tauri::command]
pub async fn list_codex_sessions(app: tauri::AppHandle, fresh: Option<bool>) -> Result<Vec<CodexSessionEntry>, String> {
    let homes = ProfileHomes::of(&app);
    crate::blocking(move || {
        static WSL_CACHE: Mutex<Option<(std::time::Instant, Vec<CodexSessionEntry>)>> = Mutex::new(None);
        // Every profile's Codex home, the default one first; each entry says
        // which profile it came from.
        let mut sessions: Vec<CodexSessionEntry> = homes
            .codex
            .iter()
            .flat_map(|(profile, home)| scan_codex_sessions(&home.join("sessions"), None, profile.as_deref()))
            .collect();
        let wsl = {
            let mut cache = lock(&WSL_CACHE);
            match cache.as_ref() {
                Some((at, cached)) if at.elapsed() < WSL_SCAN_TTL && fresh != Some(true) => cached.clone(),
                _ => {
                    let fresh = wsl_codex_sessions_root()
                        .map(|(distro, root)| scan_codex_sessions(&root, Some(&distro), None))
                        .unwrap_or_default();
                    *cache = Some((std::time::Instant::now(), fresh.clone()));
                    fresh
                }
            }
        };
        sessions.extend(wsl);
        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));

        // Threads open right now go first, marked live - wherever they run -
        // and are left out of the saved ones.
        let mut live: Vec<LiveThread> = host_live_threads(&homes.codex);
        if wsl_codex_sessions_root().is_some() {
            live.extend(wsl_live_threads(None));
        }
        sessions.retain(|s| !live.iter().any(|t| t.id == s.session_id));
        sessions.truncate(MAX_CODEX_SESSIONS);
        let mut all: Vec<CodexSessionEntry> = live
            .iter()
            .map(|t| CodexSessionEntry {
                cwd: t.cwd.clone(),
                session_id: t.id.clone(),
                started_at: t.updated_at,
                wsl_distro: t.wsl_distro.clone(),
                name: t.name.clone(),
                live: true,
                status: Some(t.status().to_string()),
                in_flowcode: t.pty_id.is_some(),
                profile: t.profile.clone(),
            })
            .collect();
        all.extend(sessions);
        Ok(all)
    })
    .await
}

/// How long one scan of a sessions folder serves: the sidebar and the agents
/// list poll every few seconds, once per profile.
pub(super) const CODEX_SCAN_REUSE: std::time::Duration = std::time::Duration::from_secs(4);

pub(super) fn scan_codex_sessions(root: &Path, wsl_distro: Option<&str>, profile: Option<&str>) -> Vec<CodexSessionEntry> {
    type Cache = HashMap<PathBuf, (std::time::Instant, Vec<CodexSessionEntry>)>;
    static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);
    if let Some((at, sessions)) = lock(&CACHE).get(root) {
        if at.elapsed() < CODEX_SCAN_REUSE {
            return sessions.clone();
        }
    }

    // Only the newest day folders are walked, and a few more files than shown
    // (some are sub-agent threads or unreadable) - not the whole history just
    // to throw all but a handful away.
    let mut files = Vec::new();
    find_recent_rollouts(root, 5, MAX_CODEX_SESSIONS * 4, &mut files);

    // By mtime (one cheap stat each) before opening anything: a thread written
    // to recently outranks one merely started later.
    let mut files: Vec<(PathBuf, Option<u64>)> = files
        .into_iter()
        .map(|p| {
            let mtime = crate::fs::system_time_to_millis(std::fs::metadata(&p).and_then(|m| m.modified()));
            (p, mtime)
        })
        .collect();
    files.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));

    let mut sessions: Vec<CodexSessionEntry> = files
        .iter()
        .filter_map(|(path, mtime)| read_codex_session(path, *mtime, wsl_distro, profile))
        .take(MAX_CODEX_SESSIONS)
        .collect();
    if !sessions.is_empty() {
        let names = codex_thread_names(root);
        for session in &mut sessions {
            session.name = names.get(&session.session_id).cloned();
        }
    }
    lock(&CACHE).insert(root.to_path_buf(), (std::time::Instant::now(), sessions.clone()));
    sessions
}
