//! What a terminal is running in the foreground (shell, agent, other), read
//! off the process tree under the pty's child.

use super::*;

/// What is at the front of a terminal tab right now, as the OS sees it -
/// the basis for anything that types a command into a tab (the explorer's
/// `cd`, shortcuts, runCommand plugins): it has to know whether a shell is
/// actually waiting at its prompt, and which one, to write in its syntax.
/// Asked of the OS rather than inferred from what the user typed, so a
/// history recall, an alias or a script that starts a shell can't fool it.
#[derive(Serialize)]
pub struct Foreground {
    /// "cmd" | "powershell" | "posix" (bash, zsh, sh, dash, ksh, csh...) |
    /// "fish" | "nu" - a shell at its prompt, in that syntax;
    /// "wsl" - a WSL session (whatever Linux shell runs inside it, POSIX `cd`);
    /// "remote" - ssh/mosh/telnet: a shell, but on another machine;
    /// "program" - anything else (a dev server, an editor, Claude Code...):
    /// typing into it would be input to that program, not a command.
    pub(super) kind: &'static str,
    /// Name of the foreground process, for diagnostics.
    pub(super) program: String,
    /// "wsl" only: the distro named on its command line (`-d`), if any.
    pub(super) wsl_distro: Option<String>,
}

pub(super) fn classify(process: &sysinfo::Process) -> Foreground {
    let program = process_stem(process);
    // `C:\Windows\System32\bash.exe` is WSL's legacy launcher, not a bash.
    let system32_bash = cfg!(windows)
        && program == "bash"
        && process
            .exe()
            .is_some_and(|exe| exe.to_string_lossy().to_lowercase().contains(r"\windows\system32\"));
    let kind = match program.as_str() {
        "cmd" => "cmd",
        "powershell" | "pwsh" => "powershell",
        "wsl" => "wsl",
        _ if system32_bash => "wsl",
        "bash" | "zsh" | "sh" | "dash" | "ash" | "ksh" | "mksh" | "pdksh" | "yash" | "csh" | "tcsh" => "posix",
        "fish" => "fish",
        "nu" => "nu",
        "ssh" | "mosh" | "mosh-client" | "telnet" => "remote",
        _ => "program",
    };
    let wsl_distro = (kind == "wsl")
        .then(|| {
            let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            args.iter()
                .position(|a| a == "-d" || a == "--distribution")
                .and_then(|i| args.get(i + 1).cloned())
        })
        .flatten();
    Foreground { kind, program, wsl_distro }
}

/// Follows the tab's process tree down from its shell: at each level the
/// most recently started child is the one in front (the console hosts
/// ConPTY hangs off the shell don't count). Stops at a WSL or ssh client -
/// whatever runs past it is on the Linux/remote side. The only option on
/// Windows, which has no notion of a terminal's foreground process; the Unix
/// fallback when the pty can't tell.
pub(super) fn foreground_by_tree(sys: &sysinfo::System, root: sysinfo::Pid) -> Option<Foreground> {
    let mut children_of: HashMap<sysinfo::Pid, Vec<&sysinfo::Process>> = HashMap::new();
    for process in sys.processes().values() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(process);
        }
    }
    let mut current = sys.process(root)?;
    for _ in 0..64 {
        let fg = classify(current);
        if matches!(fg.kind, "wsl" | "remote") {
            return Some(fg);
        }
        let next = children_of
            .get(&current.pid())
            .into_iter()
            .flatten()
            .filter(|p| !matches!(process_stem(p).as_str(), "conhost" | "openconsole"))
            .max_by_key(|p| (p.start_time(), p.pid()));
        match next {
            Some(child) => current = child,
            None => return Some(fg),
        }
    }
    Some(classify(current))
}

/// `leader`: the pty's foreground process group leader, where the OS has
/// one (Unix); `root`: the tab's own shell, for the process-tree fallback.
pub(super) fn foreground(leader: Option<u32>, root: u32) -> Option<Foreground> {
    crate::system::with_processes(|sys| {
        if let Some(fg) = leader.and_then(|pid| sys.process(sysinfo::Pid::from_u32(pid))).map(classify) {
            return Some(fg);
        }
        foreground_by_tree(sys, sysinfo::Pid::from_u32(root))
    })
}

#[tauri::command]
pub async fn pty_foreground(state: State<'_, PtyState>, id: String) -> Result<Foreground, String> {
    let (root, leader) = {
        let sessions = lock(&state.0);
        let session = sessions.get(&id).ok_or("unknown pty session")?;
        // Unix: the terminal's foreground process group - the kernel's own
        // answer to "who gets what's typed", exact by definition.
        #[cfg(unix)]
        let leader = lock(&session.master).process_group_leader().map(|pid| pid as u32);
        #[cfg(not(unix))]
        let leader: Option<u32> = None;
        (session.pid, leader)
    };
    let root = root.ok_or("pid della shell sconosciuto")?;
    crate::blocking(move || foreground(leader, root).ok_or_else(|| "shell non trovata".to_string())).await
}
