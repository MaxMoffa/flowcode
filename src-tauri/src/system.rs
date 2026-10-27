use serde::Serialize;
use crate::util::lock;
use std::sync::Mutex;
use sysinfo::{Disks, System};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

/// The app's one process table, kept between uses: the agents poll (every
/// couple of seconds) and the tab foreground checks only have to read the
/// command line, exe and working directory of processes that started since,
/// instead of every process on the machine each time. Those don't change
/// over a process's life; names and parents are refreshed every time, and
/// exited processes dropped.
pub fn with_processes<T>(f: impl FnOnce(&System) -> T) -> T {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    /// Several pollers (agents, foreground checks) land within milliseconds of
    /// each other; a refresh that fresh would just repeat the same scan.
    const MIN_REFRESH_GAP: std::time::Duration = std::time::Duration::from_millis(500);
    static SYS: std::sync::LazyLock<Mutex<(System, Option<std::time::Instant>)>> =
        std::sync::LazyLock::new(Default::default);
    let mut guard = lock(&SYS);
    let (sys, last_refresh) = &mut *guard;
    if last_refresh.is_none_or(|t| t.elapsed() >= MIN_REFRESH_GAP) {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet),
        );
        *last_refresh = Some(std::time::Instant::now());
    }
    f(sys)
}

#[derive(Serialize)]
pub struct DiskInfo {
    total: u64,
    available: u64,
}

#[derive(Serialize)]
pub struct SystemInfo {
    /// Full OS name (e.g. "Windows 11 Pro", "macOS 15.1", a Linux distro
    /// name) - `None` only if the OS layer itself couldn't be read.
    os_name: Option<String>,
    /// The build/version string alongside `os_name` (e.g. "10.0.26200") -
    /// kept separate since not every platform folds it into `os_name`.
    os_version: Option<String>,
    /// Short, human-friendly CPU architecture label (e.g. "x64", "ARM64") -
    /// derived from the compile target, not queried at runtime, since this
    /// process's own architecture is what actually matters for compatibility.
    arch: String,
    /// Bytes - the frontend formats these (GiB, one decimal) for display, so
    /// no unit conversion or rounding happens on this side.
    memory_total: u64,
    memory_available: u64,
    /// The disk backing the user's home directory, if one could be matched -
    /// `None` on a platform with no disks reported rather than guessing.
    disk: Option<DiskInfo>,
}

/// System/memory/disk info for the ASCII splash written into a fresh
/// terminal tab - read fresh on every call (no caching): this only ever runs
/// once per new tab. `(async)` (like the WSL lookups below, which spawn
/// `wsl.exe`) so the disk/memory queries never run on the UI thread.
#[tauri::command(async)]
pub fn system_info() -> SystemInfo {
    let mut sys = System::new();
    sys.refresh_memory();

    let home = crate::fs::user_home();

    let disks = Disks::new_with_refreshed_list();
    // The disk whose mount point is the longest matching prefix of the
    // user's home dir (correct on a multi-drive machine, where a naive
    // "first disk in the list" could just as easily land on a secondary
    // drive) - falls back to whatever disk comes first if home couldn't be
    // resolved or matched no mount point at all.
    let disk = home
        .as_deref()
        .and_then(|home| {
            disks
                .list()
                .iter()
                .filter(|d| home.starts_with(d.mount_point()))
                .max_by_key(|d| d.mount_point().as_os_str().len())
        })
        .or_else(|| disks.list().first())
        .map(|d| DiskInfo {
            total: d.total_space(),
            available: d.available_space(),
        });

    SystemInfo {
        os_name: System::long_os_version(),
        os_version: System::os_version(),
        arch: friendly_arch().to_string(),
        memory_total: sys.total_memory(),
        memory_available: sys.available_memory(),
        disk,
    }
}

/// Squares off (or restores) DWM's own rounded window corners - the
/// frontend calls this whenever it decides the window is flush against the
/// screen edge (real maximize or Windows-Snap-tiled; see App.tsx's
/// `isMaximized`/`isEdgeFlush` and `set_window_corner_rounding`'s own doc
/// comment for why that matters). A no-op everywhere but Windows, since
/// that's the only platform this DWM attribute applies to.
#[tauri::command]
pub fn set_window_square_corners(window: tauri::WebviewWindow, square: bool) {
    #[cfg(target_os = "windows")]
    flowcode_shared::set_window_corner_rounding(&window, !square);
    #[cfg(not(target_os = "windows"))]
    let _ = (window, square);
}

/// Hands a file the built-in editor can't show (an image, a PDF, an archive...)
/// to the OS default app for it. Goes through the opener plugin's Rust API
/// rather than its JS `openPath`: that one is gated by a path scope this app
/// never configures (every path answers ForbiddenPath), and a file the
/// explorer lists can live anywhere - a `\\wsl.localhost\<distro>\...` share
/// included, which ShellExecute opens like any other UNC path.
#[tauri::command(async)]
pub fn open_with_default_app(path: String) -> Result<(), String> {
    let target = openable_path(&path)?;
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// The real on-disk path `path` names, fit to hand to the default app - or
/// why not. Judged on the canonical name too, not just the one asked for: a
/// link `notes.txt` -> `run.bat`, or `run.exe.` (Windows drops the trailing
/// dot), would otherwise slip a program past the extension check.
fn openable_path(path: &str) -> Result<std::path::PathBuf, String> {
    use flowcode_shared::i18n::tr;
    let not_local = || {
        tr("Flowcode apre solo file locali o di WSL.", "Flowcode only opens local or WSL files.").to_string()
    };
    let executable = || {
        tr(
            "Per sicurezza Flowcode non apre file eseguibili: aprilo dal terminale se ti fidi.",
            "For safety Flowcode doesn't open executable files: run it from the terminal if you trust it.",
        )
        .to_string()
    };
    let asked = std::path::Path::new(path);
    // Before canonicalize: resolving a share (or a link to one) already
    // makes Windows log in to that server.
    if !crate::fs::is_local_path(asked, true) || !crate::fs::links_stay_local(asked) {
        return Err(not_local());
    }
    if is_executable_file(asked) {
        return Err(executable());
    }
    let real = std::fs::canonicalize(asked).map_err(|e| e.to_string())?;
    if !crate::fs::is_local_path(&real, true) {
        return Err(not_local());
    }
    if is_executable_file(&real) {
        return Err(executable());
    }
    Ok(strip_verbatim(real))
}

/// `\?\C:\x` -> `C:\x`, `\?\UNC\srv\share\x` -> `\srv\share\x`: what
/// `canonicalize` returns on Windows, turned back into the form every app
/// handed the path by ShellExecute understands.
fn strip_verbatim(path: std::path::PathBuf) -> std::path::PathBuf {
    let Some(s) = path.to_str() else { return path };
    if let Some(rest) = s.strip_prefix(r"\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\{rest}"));
    }
    match s.strip_prefix(r"\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => std::path::PathBuf::from(rest),
        _ => path,
    }
}

/// Extensions whose default handler runs code (or mounts/installs something
/// that does): a click in the explorer on `x.bat` from a cloned repo must not
/// launch it. Authoritative; `EXECUTABLE_EXT` in src/lib/filePaths.ts mirrors
/// it to hide the "open" action up front (a test keeps the two in sync).
const DENIED_OPEN_EXT: &str = concat!(
    "exe com bat cmd ps1 psm1 psd1 ps1xml vbs vbe vb js jse mjs cjs wsf wsh ws wsc sct hta msi msp mst scr lnk url website ",
    "cpl reg jar jnlp appref-ms application xbap app command sh bash zsh fish ksh csh pif inf ins isp scf gadget msc chm xll ",
    "py pyw pyc pyz pl rb php appx msix appxbundle msixbundle appinstaller diagcab vsix mdb accde accdb ade adp ",
    "library-ms searchconnector-ms settingcontent-ms iso img vhd vhdx desktop appimage run bin deb rpm pkg dmg apk tool workflow",
);

/// Whether opening `path` with the OS default handler would run code. Judged
/// by extension (case-insensitive) everywhere, plus the exec bit on Unix. A
/// name ending in `.`/space (Windows trims it: `run.exe.` opens `run.exe`) or
/// naming an alternate data stream (`a.txt:x.exe`) counts as executable.
fn is_executable_file(p: &std::path::Path) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    if name.ends_with('.') || name.ends_with(' ') || name.contains(':') {
        return true;
    }
    if p.extension().is_some_and(|e| DENIED_OPEN_EXT.split(' ').any(|d| e.eq_ignore_ascii_case(d))) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
            return true;
        }
    }
    false
}

/// How long one `wsl.exe` call may take: a wedged WSL service must not hang
/// the caller (often a poll holding a worker thread) forever.
const WSL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Runs a prepared `wsl.exe` command to completion with output captured
/// (stdin closed, no console window), killing it after `WSL_TIMEOUT`.
/// `None` when it can't start or times out.
pub(crate) fn run_wsl(mut cmd: std::process::Command) -> Option<std::process::Output> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    flowcode_shared::wait_with_timeout(cmd.spawn().ok()?, WSL_TIMEOUT).ok()
}

/// The machine's default WSL distro name (e.g. "Ubuntu"), for translating a
/// POSIX path reported by a bare `wsl` session (no explicit `-d`) into a
/// browsable `\\wsl.localhost\<distro>\...` UNC path - see wslPath.ts.
/// `None` on any non-Windows platform (no `wsl.exe` to spawn) or if WSL
/// itself isn't installed, both of which just fail the process spawn below.
#[tauri::command(async)]
pub fn wsl_default_distro() -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "-v"]);
    let output = run_wsl(cmd)?;
    if !output.status.success() {
        return None;
    }
    let text = decode_wsl_output(&output.stdout);
    // `*` marks the default distro's row in `-l -v` output (e.g.
    // "  * Ubuntu    Running   2") - more reliable than assuming row order,
    // which `-l -q` (no marker at all) would otherwise force us to do.
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix('*'))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string)
}

/// The home directory of the user a WSL session runs as (e.g.
/// `/home/alice`, `/root`). Needed because bash reports its cwd through the
/// OSC title with `$HOME` collapsed to `~` (`\w`), and `~` is exactly where
/// a freshly entered `wsl` starts - so without expanding it against the
/// *distro's* idea of home, the explorer could never follow a session into
/// the home tree at all (see App.tsx's `handleTitleChange`). Asked of the
/// distro itself rather than assumed to be `/home/<user>`, which neither
/// `root` nor a custom passwd entry matches. `user` comes from the title's
/// own `user@host:` prefix; `None` falls back to the distro's default user.
#[tauri::command(async)]
pub fn wsl_home_dir(distro: String, user: Option<String>) -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", &distro]);
    if let Some(user) = user.as_deref().filter(|u| !u.is_empty()) {
        cmd.args(["-u", user]);
    }
    // `printf` rather than `echo` to avoid a trailing newline, and `sh` so
    // this doesn't depend on the session's own (possibly non-bash) shell.
    cmd.args(["-e", "sh", "-c", "printf %s \"$HOME\""]);
    let output = run_wsl(cmd)?;
    if !output.status.success() {
        return None;
    }
    let home = decode_wsl_output(&output.stdout).trim().to_string();
    // A distro that failed to resolve the user prints its error to stdout in
    // some builds, so only a real POSIX path counts as an answer.
    home.starts_with('/').then_some(home)
}

/// `wsl.exe`'s stdout is UTF-16LE (with embedded nulls) when captured
/// through a pipe on many Windows builds, unlike every other console tool
/// this app shells out to - a well-known quirk of that specific binary.
/// Detected by null-byte density rather than assumed, since which encoding
/// a given Windows build actually uses isn't consistent.
pub(crate) fn decode_wsl_output(bytes: &[u8]) -> String {
    let null_ratio = bytes.iter().filter(|&&b| b == 0).count() as f32 / bytes.len().max(1) as f32;
    if null_ratio > 0.3 {
        let utf16: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Maps Rust's compile-time target architecture to the label users actually
/// recognize (Windows itself calls x86_64 "x64" everywhere in its own UI).
fn friendly_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "x86",
        "aarch64" => "ARM64",
        "arm" => "ARM",
        other => other,
    }
}

/// PowerShell's saved command history (PSReadLine's `ConsoleHost_history.txt`,
/// shared by Windows PowerShell and pwsh), oldest first - what the up arrow
/// walks in a fresh PowerShell session, so the New Tab prompt can walk the
/// same list. Empty when there is none. A command spanning several lines is
/// saved with a trailing backtick on each line but the last; those are joined
/// back into one entry.
#[tauri::command(async)]
pub fn powershell_history() -> Vec<String> {
    const MAX_ENTRIES: usize = 500;
    let path = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|dir| {
            std::path::PathBuf::from(dir).join(r"Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt")
        })
    } else {
        std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join(".local/share/powershell/PSReadLine/ConsoleHost_history.txt"))
    };
    let Some(text) = path.and_then(|p| std::fs::read(p).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()) else {
        return Vec::new();
    };
    let mut entries: Vec<String> = Vec::new();
    let mut pending = String::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        if let Some(head) = line.strip_suffix('`') {
            pending.push_str(head);
            pending.push('\n');
            continue;
        }
        pending.push_str(line);
        let command = std::mem::take(&mut pending);
        if is_flowcode_command(&command) {
            continue;
        }
        let command = command.trim();
        if !command.is_empty() && entries.last().map(String::as_str) != Some(command) {
            entries.push(command.to_string());
        }
    }
    let skip = entries.len().saturating_sub(MAX_ENTRIES);
    entries.split_off(skip)
}

/// A line Flowcode typed into a PowerShell on its own rather than the user:
/// sent with a leading space (see `unrecorded` in src/terminal/shellDialect.ts),
/// or - saved before that was skipped - an explorer `cd`, which carries the
/// prompt wrapper's name, or the Codex usage probe.
fn is_flowcode_command(line: &str) -> bool {
    line.starts_with(' ') || line.contains("__flowcodePrompt") || line.contains("check_for_update_on_startup=false")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn executables_are_refused_by_extension_and_trimmed_name() {
        for bad in ["a.exe", "RUN.BAT", "x.chm", "a.xll", "p.appx", "i.ISO", "d.vhdx", "s.settingcontent-ms", "w.website",
            "a.exe.", "a.exe ", "a.txt.", "a.txt:x.exe", "s.ps1"]
        {
            assert!(is_executable_file(Path::new(bad)), "{bad:?}");
        }
        for ok in ["a.txt", "b.png", "c.pdf", "README", "notes.md"] {
            assert!(!is_executable_file(Path::new(ok)), "{ok:?}");
        }
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\?\C:\a\b.pdf")), PathBuf::from(r"C:\a\b.pdf"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\?\UNC\wsl.localhost\U\a")), PathBuf::from(r"\wsl.localhost\U\a"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\?\GLOBALROOT\x")), PathBuf::from(r"\?\GLOBALROOT\x"));
        assert_eq!(strip_verbatim(PathBuf::from("/home/a")), PathBuf::from("/home/a"));
    }

    #[test]
    fn openable_path_checks_the_real_file() {
        let dir = std::env::temp_dir().join(format!("flowcode-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("doc.pdf"), "x").unwrap();
        std::fs::write(dir.join("run.bat"), "x").unwrap();
        let doc = openable_path(&dir.join("doc.pdf").to_string_lossy()).unwrap();
        assert!(doc.ends_with("doc.pdf") && !doc.to_string_lossy().starts_with(r"\?\"));
        assert!(openable_path(&dir.join("run.bat").to_string_lossy()).is_err());
        assert!(openable_path(&dir.join("missing.pdf").to_string_lossy()).is_err());
        #[cfg(windows)]
        {
            assert!(openable_path(r"\attacker.invalid\share\a.pdf").is_err());
            assert!(openable_path(r"\.\pipe\x").is_err());
            // A link with an innocent name to a program: judged by its target.
            if std::os::windows::fs::symlink_file(dir.join("run.bat"), dir.join("notes.txt")).is_ok() {
                assert!(openable_path(&dir.join("notes.txt").to_string_lossy()).is_err());
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("run.bat"), dir.join("notes.txt")).unwrap();
            assert!(openable_path(&dir.join("notes.txt").to_string_lossy()).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// src/lib/filePaths.ts hides "open" for the same extensions this refuses.
    #[test]
    fn denied_extensions_match_the_frontend_list() {
        let ts = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/filePaths.ts")).unwrap();
        let start = ts.find("const EXECUTABLE_EXT").expect("EXECUTABLE_EXT in filePaths.ts");
        let block = &ts[start..start + ts[start..].find(".split(").unwrap()];
        let mut front: Vec<&str> =
            block.split('"').skip(1).step_by(2).flat_map(|s| s.split_whitespace()).collect();
        let mut back: Vec<&str> = DENIED_OPEN_EXT.split(' ').collect();
        front.sort_unstable();
        back.sort_unstable();
        assert_eq!(front, back);
    }
}
