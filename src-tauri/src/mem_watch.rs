//! Memory watch (Windows). A tester's PC crashed with system commit at
//! 84/85 GiB while the Flowcode job (terminals, agents and their children)
//! held ~70 GiB and the GUI only ~50 MB: some child ate the memory, but
//! nothing recorded which. Once a minute this samples the private commit of
//! every process in the job and the system commit, writes it to
//! `<app_data>/memory.log` (picked up by scripts/collect-crash-report.ps1),
//! and warns the user with a toast before Windows runs out.

/// How often the job is sampled.
#[cfg(windows)]
const TICK: std::time::Duration = std::time::Duration::from_secs(60);
/// Quiet periods still get a line this often, as a baseline.
#[cfg(windows)]
const BASELINE_EVERY_TICKS: u32 = 10;
/// The job at or above this is logged every tick, with command lines.
#[cfg(windows)]
const HEAVY_JOB_BYTES: u64 = 4 * GIB;
/// System commit at or above this share of the limit is logged every tick.
#[cfg(windows)]
const HEAVY_SYSTEM_PCT: u64 = 85;
/// Toast when system commit reaches this and one child holds at least
/// `TOAST_MIN_CHILD_BYTES` - so the warning names a culprit Flowcode owns.
#[cfg(windows)]
const TOAST_SYSTEM_PCT: u64 = 90;
#[cfg(windows)]
const TOAST_MIN_CHILD_BYTES: u64 = 2 * GIB;
#[cfg(windows)]
const TOAST_QUIET: std::time::Duration = std::time::Duration::from_secs(30 * 60);
#[cfg(windows)]
const LOG_CAP_BYTES: u64 = 256 * 1024;
#[cfg(windows)]
const GIB: u64 = 1024 * 1024 * 1024;

pub(crate) fn start(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Ok(dir) = app.path().app_data_dir() else { return };
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("mem-watch".into())
            .spawn(move || run(app, dir.join("memory.log")));
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
struct Sample {
    pid: u32,
    private: u64,
    peak: u64,
}

#[cfg(windows)]
fn run(app: tauri::AppHandle, log: std::path::PathBuf) {
    let mut ticks = 0u32;
    let mut last_logged_job = 0u64;
    let mut job_peak = 0u64;
    let mut last_toast: Option<std::time::Instant> = None;
    log_line(&log, &format!("watch started, Flowcode {} pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
    loop {
        std::thread::sleep(TICK);
        ticks = ticks.wrapping_add(1);
        let mut samples: Vec<Sample> = crate::process_job::pids()
            .into_iter()
            .filter_map(|pid| private_bytes(pid).map(|(private, peak)| Sample { pid, private, peak }))
            .collect();
        samples.sort_by(|a, b| b.private.cmp(&a.private));
        let job: u64 = samples.iter().map(|s| s.private).sum();
        job_peak = job_peak.max(job);
        let gui = private_bytes(std::process::id()).map_or(0, |(p, _)| p);
        let (used, limit) = system_commit();
        let pct = if limit > 0 { used * 100 / limit } else { 0 };

        let heavy = job >= HEAVY_JOB_BYTES || pct >= HEAVY_SYSTEM_PCT;
        let grew = job >= last_logged_job + GIB;
        if heavy || grew || ticks % BASELINE_EVERY_TICKS == 1 {
            last_logged_job = job;
            let top = if heavy { 5 } else { 3 };
            let names = describe(&samples[..samples.len().min(top)], heavy);
            log_line(
                &log,
                &format!(
                    "job {} in {} procs (peak {}) | gui {} | system commit {}/{} ({pct}%){}{}",
                    gib(job),
                    samples.len(),
                    gib(job_peak),
                    gib(gui),
                    gib(used),
                    gib(limit),
                    if names.is_empty() { "" } else { " | top: " },
                    names,
                ),
            );
        }

        let quiet = last_toast.is_some_and(|t| t.elapsed() < TOAST_QUIET);
        if let Some(worst) = samples.first().filter(|s| s.private >= TOAST_MIN_CHILD_BYTES) {
            if pct >= TOAST_SYSTEM_PCT && !quiet {
                last_toast = Some(std::time::Instant::now());
                let name = crate::system::with_processes(|sys| {
                    sys.process(sysinfo::Pid::from_u32(worst.pid))
                        .map(|p| p.name().to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "?".into());
                warn(&app, &name, worst.pid, worst.private, pct);
                log_line(&log, &format!("toast: {name} pid {} {} at system {pct}%", worst.pid, gib(worst.private)));
            }
        }
    }
}

/// `name#pid 3.1 GiB (peak 4.0 GiB)`, `; `-separated; with the (redacted,
/// shortened) command line when `with_cmd`.
#[cfg(windows)]
fn describe(samples: &[Sample], with_cmd: bool) -> String {
    crate::system::with_processes(|sys| {
        samples
            .iter()
            .map(|s| {
                let proc = sys.process(sysinfo::Pid::from_u32(s.pid));
                let name = proc.map_or_else(|| "?".into(), |p| p.name().to_string_lossy().into_owned());
                let mut out = format!("{name}#{} {} (peak {})", s.pid, gib(s.private), gib(s.peak));
                if with_cmd {
                    if let Some(p) = proc {
                        let args: Vec<String> =
                            p.cmd().iter().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
                        let cmd = redact(&args);
                        if !cmd.is_empty() {
                            out.push_str(&format!(" `{cmd}`"));
                        }
                    }
                }
                out
            })
            .collect::<Vec<_>>()
            .join("; ")
    })
}

/// Joins arguments, hiding values that look like secrets and capping the
/// length: the log travels in crash reports.
#[cfg(windows)]
fn redact(args: &[String]) -> String {
    const MAX: usize = 160;
    let secretish = |s: &str| {
        let l = s.to_ascii_lowercase();
        ["key", "token", "secret", "password", "passwd", "auth"].iter().any(|w| l.contains(w))
    };
    let mut out: Vec<String> = Vec::new();
    let mut hide_next = false;
    for a in args {
        if hide_next {
            out.push("***".into());
            hide_next = false;
        } else if let Some((k, _)) = a.split_once('=').filter(|(k, _)| secretish(k)) {
            out.push(format!("{k}=***"));
        } else {
            hide_next = a.starts_with('-') && secretish(a);
            out.push(a.clone());
        }
    }
    let joined = out.join(" ");
    if joined.chars().count() > MAX {
        format!("{}…", joined.chars().take(MAX).collect::<String>())
    } else {
        joined
    }
}

#[cfg(windows)]
fn warn(app: &tauri::AppHandle, name: &str, pid: u32, bytes: u64, pct: u64) {
    use flowcode_shared::i18n::tr;
    use tauri::Manager;
    let label = if app.get_window("main").is_some() {
        "main".to_string()
    } else {
        let mut labels: Vec<String> = app.windows().into_keys().collect();
        labels.sort();
        labels.into_iter().next().unwrap_or_default()
    };
    let title = tr("Memoria quasi esaurita", "Memory almost exhausted").to_string();
    let body = format!(
        "{name} (PID {pid}) {} {}. {} {pct}%.",
        tr("usa", "is using"),
        gib(bytes),
        tr("Memoria di sistema al", "System memory at"),
    );
    crate::notify::show(app.clone(), label, String::new(), title, body);
}

/// Private commit now and its peak, in bytes; `None` if the process is gone
/// or not ours to query.
#[cfg(windows)]
fn private_bytes(pid: u32) -> Option<(u64, u64)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb);
        CloseHandle(h);
        (ok != 0).then(|| (c.PrivateUsage as u64, c.PeakPagefileUsage as u64))
    }
}

/// System commit charge and commit limit, in bytes.
#[cfg(windows)]
fn system_commit() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut m: MEMORYSTATUSEX = std::mem::zeroed();
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut m) == 0 {
            return (0, 0);
        }
        (m.ullTotalPageFile.saturating_sub(m.ullAvailPageFile), m.ullTotalPageFile)
    }
}

#[cfg(windows)]
fn gib(bytes: u64) -> String {
    format!("{:.2} GiB", bytes as f64 / GIB as f64)
}

#[cfg(windows)]
fn log_line(path: &std::path::Path, text: &str) {
    let line = format!("{} {text}", crate::remote::connlog::format_utc(crate::util::now_ms()));
    eprintln!("memory: {line}");
    crate::remote::connlog::append_capped(path, &line, LOG_CAP_BYTES);
}

#[cfg(all(test, windows))]
mod tests {
    use super::redact;

    #[test]
    fn secrets_are_hidden() {
        let args: Vec<String> =
            ["--api-key", "sk-123", "OPENAI_API_KEY=abc", "run", "build"].iter().map(|s| s.to_string()).collect();
        assert_eq!(redact(&args), "--api-key *** OPENAI_API_KEY=*** run build");
    }
}
