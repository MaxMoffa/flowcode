use serde::Serialize;
use sysinfo::{Disks, System};

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
        memory_total: sys.total_memory(),
        memory_available: sys.available_memory(),
        disk,
    }
}
