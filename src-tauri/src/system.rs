use serde::Serialize;
use sysinfo::{Disks, System};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

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
/// terminal tab - read fresh on every call (no caching): each of these is a
/// single cheap OS query, and this only ever runs once per new tab anyway.
#[tauri::command]
pub fn system_info() -> SystemInfo {
    let mut sys = System::new();
    sys.refresh_memory();

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);

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

/// The machine's default WSL distro name (e.g. "Ubuntu"), for translating a
/// POSIX path reported by a bare `wsl` session (no explicit `-d`) into a
/// browsable `\\wsl.localhost\<distro>\...` UNC path - see wslPath.ts.
/// `None` on any non-Windows platform (no `wsl.exe` to spawn) or if WSL
/// itself isn't installed, both of which just fail the process spawn below.
#[tauri::command]
pub fn wsl_default_distro() -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "-v"]).stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
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
#[tauri::command]
pub fn wsl_home_dir(distro: String, user: Option<String>) -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", &distro]);
    if let Some(user) = user.as_deref().filter(|u| !u.is_empty()) {
        cmd.args(["-u", user]);
    }
    // `printf` rather than `echo` to avoid a trailing newline, and `sh` so
    // this doesn't depend on the session's own (possibly non-bash) shell.
    cmd.args(["-e", "sh", "-c", "printf %s \"$HOME\""])
        .stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
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
fn decode_wsl_output(bytes: &[u8]) -> String {
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
