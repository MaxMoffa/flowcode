//! Claude Code side of agent discovery: its agent registry, headless-run
//! filtering and the throwaway `/usage` probe.

use super::*;

/// One entry from `claude agents --json` - Claude Code's own registry of
/// every session it knows about on this machine, including ones this app
/// never spawned (another terminal window, a background/headless run, ...).
/// Far richer than the process-tree guess above, but Claude-specific: no
/// equivalent exists for Codex, so this supplements `list_agent_sessions`
/// rather than replacing it - the frontend correlates the two by `pid`.
#[derive(Deserialize, Serialize, Clone)]
pub struct ClaudeAgentEntry {
    pid: u32,
    cwd: String,
    kind: String,
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    status: String,
    /// The app whose terminal it runs in, when recognizable (see
    /// `host_app_of`) - not part of `claude agents`' own output.
    #[serde(rename = "hostApp", default)]
    host_app: Option<String>,
    /// The account profile whose Claude folder lists it (`None`: the default
    /// one) - not part of `claude agents`' own output either.
    #[serde(default)]
    profile: Option<String>,
}

/// Whether a `claude agents` entry is a one-shot `claude -p` run rather than
/// a session someone works in - the usage popover's `/usage` probe (this
/// app's, or another Flowcode's: `ProbePids` only knows our own, and only by
/// the pid of the shim it launched), or any other scripted query. Claude
/// Code lists those too; its registry entry (`~/.claude/sessions/<pid>.json`)
/// tells them apart by `entrypoint`: "cli" for an interactive or background
/// session, "sdk-..." for `-p`/SDK runs.
pub(super) fn is_headless_claude_run(pid: u32, claude_dirs: &[(Option<String>, PathBuf)]) -> bool {
    claude_registry_entry(pid, claude_dirs)
        .and_then(|v| v.get("entrypoint").and_then(|e| e.as_str()).map(|e| e.starts_with("sdk")))
        .unwrap_or(false)
}

/// Claude Code's registry entry for the session running as `pid`
/// (`<claude dir>/sessions/<pid>.json`) - kept up to date by the CLI itself,
/// `status` included: "busy" while it works, "waiting" while it waits on the
/// user (a permission prompt, a question), "idle" once its turn is over. Looked
/// up in every profile's Claude folder (the default one first): pids are
/// unique, so the first hit is the one.
pub(super) fn claude_registry_entry(pid: u32, claude_dirs: &[(Option<String>, PathBuf)]) -> Option<serde_json::Value> {
    claude_dirs.iter().find_map(|(_, dir)| {
        let text = std::fs::read_to_string(dir.join("sessions").join(format!("{pid}.json"))).ok()?;
        serde_json::from_str(&text).ok()
    })
}

/// Whether a Claude folder (any profile's) has at least one session registry file -
/// `claude agents` is only worth running for it then.
pub(super) fn has_claude_sessions(claude_dir: &Path) -> bool {
    std::fs::read_dir(claude_dir.join("sessions"))
        .map(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| e.path().extension().is_some_and(|x| x == "json"))
        })
        .unwrap_or(false)
}

/// The terminal app a process runs under, by walking up its parents: this
/// Flowcode, another Flowcode (e.g. an installed one next to a dev build), or
/// a few other well-known terminals.
pub(super) fn host_app_of(sys: &System, pid: u32) -> Option<String> {
    let own = std::process::id();
    let mut current = sys.process(Pid::from_u32(pid))?.parent();
    for _ in 0..32 {
        let process = sys.process(current?)?;
        let raw = process.name().to_string_lossy().to_lowercase();
        let stem = raw.strip_suffix(".exe").unwrap_or(&raw);
        let app = match stem {
            "flowcode" if process.pid().as_u32() == own => "Flowcode",
            "flowcode" => tr("altra istanza di Flowcode", "another Flowcode instance"),
            "windowsterminal" => "Windows Terminal",
            "code" => "VS Code",
            "cursor" => "Cursor",
            "idea64" | "idea" => "IntelliJ IDEA",
            "iterm2" => "iTerm2",
            "terminal" => tr("Terminale", "Terminal"),
            _ => {
                current = process.parent();
                continue;
            }
        };
        return Some(app.to_string());
    }
    None
}

/// How long one `claude agents --json` answer is reused: the frontend polls
/// every few seconds, and each run is a `cmd` + Node start-up.
pub(super) const CLAUDE_AGENTS_TTL: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) const CLAUDE_AGENTS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The usage probe is a real `claude -p` start-up, and can be slow.
pub(super) const CLAUDE_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
pub(super) struct AgentsRun {
    running: bool,
    /// The last answer, and when it came.
    last: Option<(std::time::Instant, Vec<ClaudeAgentEntry>)>,
}

/// What `claude agents --json` lists for one profile (`dir`: its Claude
/// folder), without a process spawn per call: an answer under
/// `CLAUDE_AGENTS_TTL` old is reused, and while a run is in flight (a slow
/// one, overlapping polls) callers get the last answer instead of starting
/// another. The command is killed after `CLAUDE_AGENTS_TIMEOUT`.
pub(super) fn claude_agents_for(profile: &Option<String>, dir: &Path) -> Result<Vec<ClaudeAgentEntry>, String> {
    static RUNS: LazyLock<Mutex<HashMap<Option<String>, AgentsRun>>> = LazyLock::new(Default::default);
    {
        let mut runs = lock(&RUNS);
        let run = runs.entry(profile.clone()).or_default();
        if let Some((at, entries)) = &run.last {
            if at.elapsed() < CLAUDE_AGENTS_TTL {
                return Ok(entries.clone());
            }
        }
        if run.running {
            return Ok(run.last.as_ref().map(|(_, e)| e.clone()).unwrap_or_default());
        }
        run.running = true;
    }
    let envs = match profile {
        Some(_) => vec![("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().into_owned())],
        None => Vec::new(),
    };
    // `Ok(None)`: no fresh answer (timed out) - nothing to cache.
    let result: Result<Option<Vec<ClaudeAgentEntry>>, String> =
        match flowcode_shared::run_command_blocking_timeout("claude agents --json", &envs, CLAUDE_AGENTS_TIMEOUT) {
            // Not installed, not on PATH, or an old version without this
            // subcommand - all read the same to the frontend: no data, not an
            // error to surface (the usage popover already has its own separate
            // "not installed"/"not logged in" messaging for Claude).
            Ok(output) if !output.status.success() => Ok(Some(Vec::new())),
            Ok(output) => serde_json::from_slice(&output.stdout).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(e.to_string()),
        };
    let mut runs = lock(&RUNS);
    let run = runs.entry(profile.clone()).or_default();
    run.running = false;
    match result {
        Ok(Some(entries)) => {
            run.last = Some((std::time::Instant::now(), entries.clone()));
            Ok(entries)
        }
        Ok(None) => Ok(run.last.as_ref().map(|(_, e)| e.clone()).unwrap_or_default()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn list_claude_agents(
    app: tauri::AppHandle,
    probe_pids: State<'_, ProbePids>,
) -> Result<Vec<ClaudeAgentEntry>, String> {
    let homes = ProfileHomes::of(&app);
    // `claude agents` once for the default profile, then once more for every
    // other profile that has ever registered a session (an untouched profile
    // isn't worth a process spawn per poll).
    let claude_dirs = homes.claude.clone();
    let runs = crate::blocking(move || {
        let mut runs: Vec<(Option<String>, Vec<ClaudeAgentEntry>)> = Vec::new();
        for (profile, dir) in &claude_dirs {
            if !has_claude_sessions(dir) {
                continue;
            }
            match claude_agents_for(profile, dir) {
                Ok(entries) => runs.push((profile.clone(), entries)),
                // The default run failing to start or to parse is an error.
                Err(e) if profile.is_none() => return Err(e),
                Err(_) => {}
            }
        }
        Ok(runs)
    })
    .await?;

    let mut entries: Vec<ClaudeAgentEntry> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for (profile, parsed) in runs {
        for mut entry in parsed {
            // First wins: the default profile's run comes first.
            if seen.insert(entry.pid) {
                entry.profile = profile.clone();
                entries.push(entry);
            }
        }
    }
    let entries: Vec<ClaudeAgentEntry> = {
        let excluded = lock(&probe_pids.0);
        entries.into_iter().filter(|e| !excluded.contains(&e.pid)).collect()
    };
    if entries.is_empty() {
        return Ok(entries);
    }
    crate::blocking(move || {
        let entries: Vec<ClaudeAgentEntry> =
            entries.into_iter().filter(|e| !is_headless_claude_run(e.pid, &homes.claude)).collect();
        Ok(crate::system::with_processes(|sys| {
            entries
                .into_iter()
                .map(|mut e| {
                    e.host_app = host_app_of(sys, e.pid);
                    e
                })
                .collect()
        }))
    })
    .await
}

/// Runs `claude -p "/usage"` for the usage popover (see src/plugins/usage.ts)
/// - a plain-text, client-side-only query, no model call. Spawned directly
/// (no shell) rather than through `run_command_blocking`: that both sidesteps
/// the cmd.exe re-quoting hazard documented on `cli_is_logged_in` and, more
/// importantly, hands back the *actual* `claude` pid - the one the registry
/// behind `list_claude_agents` will report - so it can be tracked in
/// `ProbePids` and filtered out of it for the short time it's alive.
#[tauri::command]
pub async fn run_claude_usage_probe(
    app: tauri::AppHandle,
    probe_pids: State<'_, ProbePids>,
    profile: Option<String>,
) -> Result<String, String> {
    if profile.is_some() && crate::profiles::dirs(&app, profile.as_deref()).is_none() {
        return Err("Unknown profile".to_string());
    }
    let mut cmd = std::process::Command::new("claude");
    cmd.envs(crate::profiles::env_for(&app, profile.as_deref()))
        .arg("-p")
        .arg("/usage")
        .stdin(std::process::Stdio::null())
        // This probe runs every few minutes in the background: it has no
        // business starting a self-update of the user's install each time
        // (interactive sessions still update as usual).
        .env("DISABLE_AUTOUPDATER", "1")
        // `wait_with_output` below only captures stdout/stderr that were
        // actually piped - left as the default `Stdio::inherit()`, this
        // process's output goes to the app's own (invisible) console and
        // `Output.stdout` comes back empty every time, which is exactly what
        // broke the usage popover: the probe "succeeded" with zero output.
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    // `claude` resolves to a .cmd shim, which Rust runs via a hidden
    // cmd.exe - without this it flashes a console window open/closed on
    // every poll (this probe fires on a multi-second interval).
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    lock(&probe_pids.0).insert(pid);

    let result = tauri::async_runtime::spawn_blocking(move || flowcode_shared::wait_with_timeout(child, CLAUDE_PROBE_TIMEOUT)).await;

    lock(&probe_pids.0).remove(&pid);

    let output = result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if !output.status.success() {
        // Everything it printed, not just stderr: claude often reports a
        // failure on stdout, and an empty error leaves the popover's debug
        // info with nothing to go on.
        let printed = flowcode_shared::combined_output(&output);
        return Err(format!("claude -p /usage: {}
{printed}", output.status).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
