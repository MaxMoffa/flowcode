//! Which shell a terminal runs: the default, the Settings choices, resolving
//! an id to a program, and the one-off ConPTY warmup.

use super::*;

/// Runs the ConPTY warmup below exactly once per process, and - this is the
/// point - *blocks* every other caller until that one run has finished.
/// `setup()` kicks it off early on its own thread so the wait is normally
/// already over by the time it matters; `pty_spawn` goes through the same
/// gate, so a frontend that gets to its first tab quickly waits for the
/// warmup instead of racing it. Without this gate the warmup was pure
/// optimism: nothing stopped the first real tab's `CreatePseudoConsole` from
/// happening first anyway, which is exactly the case it exists to prevent.
#[cfg(target_os = "windows")]
pub(super) static CONPTY_WARMUP: std::sync::Once = std::sync::Once::new();

#[cfg(target_os = "windows")]
pub fn warmup_conpty() {
    CONPTY_WARMUP.call_once(run_conpty_warmup);
}

/// Spawns and immediately tears down a throwaway ConPTY session, blocking
/// until it exits. Windows-only, called once from `lib.rs`'s `setup()`
/// before the window/webview is shown.
///
/// The very first `CreatePseudoConsole` a process ever makes can come up
/// with its input pipe not actually wired to the child yet - the shell
/// prints its prompt fine (output flows), but nothing typed reaches it,
/// with no error anywhere. Every ConPTY after that first one behaves
/// normally. Ending up with the user's actual first terminal tab being the
/// one that silently eats keystrokes is exactly backwards - so this makes
/// something else be the "first" one instead, before there's a real tab
/// (or a user) around to notice.
#[cfg(target_os = "windows")]
pub(super) fn run_conpty_warmup() {
    let pty_system = native_pty_system();
    let Ok(pair) = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) else {
        return;
    };
    // Always cmd.exe here, regardless of the user's configured default
    // shell (`default_shell()` below) - this only needs *some* process to
    // round-trip through ConPTY, and cmd.exe is guaranteed present.
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/c", "exit"]);
    let Ok(mut child) = pair.slave.spawn_command(cmd) else {
        return;
    };
    drop(pair.slave);
    // Even `cmd.exe /c exit` writes a few dozen bytes of mode-set/title
    // escapes on its way out - if nothing drains the pty's output pipe, the
    // write can block once that pipe fills, which blocks the exit itself,
    // which means `child.wait()` below never returns. A real pty_spawn
    // session never hits this because its own reader thread (below) is
    // always draining output; this one-off warmup needs the same, even
    // though it has nowhere to send what it reads.
    if let Ok(mut reader) = pair.master.try_clone_reader() {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
    }
    // Bounded, not `child.wait()`: this runs inside `CONPTY_WARMUP.call_once`,
    // which every `pty_spawn` call blocks on (see below) - if this particular
    // throwaway `cmd.exe /c exit` ever fails to exit on its own (seen in
    // practice: it can sit alive indefinitely with no error anywhere), an
    // unbounded wait here would wedge the `Once` forever and silently take
    // every terminal tab down with it, not just this one warmup session.
    // Polling with a deadline, killing on timeout, guarantees this always
    // returns - worst case the warmup is skipped and the real first tab
    // absorbs the stuck-input-pipe quirk this exists to prevent, which is
    // exactly the pre-warmup behavior, not a new failure mode.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }
}

/// Windows: PowerShell 7 when it's installed, Windows PowerShell (always
/// there) otherwise - what Windows Terminal opens too. Not COMSPEC: that is
/// cmd.exe on every Windows install, so it says nothing about what the user
/// prefers; cmd stays one pick away in Settings.
pub(super) fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        if on_path("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Whether `program` sits in one of PATH's directories. `symlink_metadata`,
/// not `is_file`: a Microsoft Store pwsh is an App Execution Alias in
/// WindowsApps, a reparse point that plain `metadata` can't follow even
/// though CreateProcess launches it fine.
pub(super) fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| std::fs::symlink_metadata(dir.join(program)).is_ok()))
        .unwrap_or(false)
}

#[derive(Serialize)]
pub struct ShellOption {
    /// Sent back verbatim as `pty_spawn`'s `shell` argument - `"system"`
    /// (always first, and the default the Settings page pre-selects) means
    /// "whatever `default_shell()` already picks", so choosing it changes
    /// nothing from today's behavior.
    id: String,
    label: String,
}

/// Whether `wsl.exe` resolves to a real, usable WSL install with at least
/// one distro registered - `-l -q` (quiet, just distro names, no `-v`
/// table header to parse) exits non-zero both when WSL itself isn't
/// installed at all and when it's installed but has no distro yet, either
/// of which means there's nothing a "wsl" shell option could actually
/// launch. Same spawn shape as `wsl_default_distro` in system.rs.
#[cfg(target_os = "windows")]
pub(super) fn wsl_installed() -> bool {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "-q"]).stdin(std::process::Stdio::null());
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Bounded: a wedged WSL service must not hang the Settings page.
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    cmd.spawn()
        .and_then(|child| flowcode_shared::wait_with_timeout(child, Duration::from_secs(10)))
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// The terminal choices the Settings page offers, filtered to what actually
/// makes sense on this OS - a Windows build has no business offering zsh,
/// and vice versa. "wsl" only ever appears when `wsl_installed()` finds a
/// real, usable install - offering it otherwise would just hand back a
/// shell option that fails the moment it's picked.
///
/// `(async)`: probing for WSL spawns `wsl.exe`, which must not block the UI thread.
#[tauri::command(async)]
pub fn list_shell_options() -> Vec<ShellOption> {
    // Labels are language-neutral names: the frontend words "system" and
    // "cmd" in the UI language itself (see shellOptions.ts), since this list
    // is fetched once and must follow a later language change.
    let mut options = vec![ShellOption { id: "system".into(), label: String::new() }];
    if cfg!(target_os = "windows") {
        // Names what "system" resolves to - on Windows it's Flowcode's own
        // pick (see `default_shell`), not something the OS reports.
        options[0].label = if on_path("pwsh.exe") { "PowerShell 7" } else { "Windows PowerShell" }.into();
        options.push(ShellOption { id: "cmd".into(), label: "cmd".into() });
        options.push(ShellOption { id: "powershell".into(), label: "Windows PowerShell".into() });
        // Like WSL below, only when it's really there: offering it otherwise
        // hands back a tab that can't start its shell.
        if on_path("pwsh.exe") {
            options.push(ShellOption { id: "pwsh".into(), label: "PowerShell 7".into() });
        }
        #[cfg(target_os = "windows")]
        if wsl_installed() {
            options.push(ShellOption { id: "wsl".into(), label: "WSL".into() });
        }
    } else if cfg!(target_os = "macos") {
        options.push(ShellOption { id: "zsh".into(), label: "zsh".into() });
        options.push(ShellOption { id: "bash".into(), label: "bash".into() });
    } else {
        options.push(ShellOption { id: "bash".into(), label: "bash".into() });
        options.push(ShellOption { id: "zsh".into(), label: "zsh".into() });
        options.push(ShellOption { id: "sh".into(), label: "sh (POSIX)".into() });
    }
    options
}

/// Turns a `ShellOption::id` (as chosen in Settings, round-tripped through
/// `pty_spawn`'s `shell` argument) into the actual program to spawn. Falls
/// back to treating an unrecognized id as a literal program name rather than
/// erroring - keeps this forward-compatible with an id this version of the
/// list doesn't know about (e.g. after a downgrade) instead of breaking every
/// new tab.
pub(super) fn resolve_shell(id: Option<&str>) -> String {
    match id {
        None | Some("") | Some("system") => default_shell(),
        Some("cmd") => "cmd.exe".into(),
        Some("powershell") => "powershell.exe".into(),
        // A remembered pick (recent terminal, favorite, setting) can outlive
        // the install - Windows PowerShell is what's left then.
        Some("pwsh") => if on_path("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() },
        Some("wsl") => "wsl.exe".into(),
        Some(id) if id.starts_with("wsl:") => "wsl.exe".into(),
        Some("zsh") => "zsh".into(),
        Some("bash") => "bash".into(),
        Some("sh") => "sh".into(),
        Some(other) => other.to_string(),
    }
}

/// `\\wsl.localhost\Ubuntu\home\me` (or the older `\\wsl$\...` form) ->
/// `("Ubuntu", "/home/me")`. A WSL folder only reaches the frontend in that
/// UNC form (see wslPath.ts), but it can't be wsl.exe's cwd as-is - the
/// distro would start in its default dir instead - so it's handed over as
/// `-d <distro> --cd <posix path>`.
pub(crate) fn split_wsl_unc(path: &str) -> Option<(String, String)> {
    let lower = path.to_ascii_lowercase();
    let prefix = [r"\\wsl.localhost\", r"\\wsl$\"]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let rest = &path[prefix.len()..];
    let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    if distro.is_empty() {
        return None;
    }
    let tail = tail.trim_end_matches('\\').replace('\\', "/");
    Some((distro.to_string(), format!("/{tail}")))
}
