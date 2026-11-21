//! Crash detection. A release build aborts on panic (`panic = "abort"`) and is
//! stripped, so nothing in-process can report a crash after the fact. Instead
//! each real app session leaves a small marker file on disk and removes it on a
//! clean exit; whatever markers a later launch finds belonging to dead
//! processes are sessions that ended badly.
//!
//! Layout, all under `<app_data_dir>/crash/`:
//! - `session-<pid>.json`  written at startup, removed on a clean exit
//! - `panic-<pid>.json`    written by the panic hook just before the abort
//! - `pending-<id>.json`   a finished report waiting for the frontend to show
//! - `diagnosis-<id>.json` what an agent concluded about that report (see `attach_diagnosis`)
//! - `muted.json`          signatures the user asked never to be told about
//!
//! A marker with no evidence (no panic file, no Windows "Application Error"
//! event) is dropped without a report: the user shutting down Windows or
//! killing the process in Task Manager looks exactly like that, and must not
//! pop a crash dialog.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Emitter, Manager};

/// Where crash files live. Set once in `init`; the panic hook reads it, so a
/// panic before `init` simply leaves no trace.
static CRASH_DIR: OnceLock<PathBuf> = OnceLock::new();

const ISSUE_URL: &str = "https://github.com/MaxMoffa/flowcode/issues/new";
/// Browsers and GitHub choke on very long URLs; stay well under common limits.
const MAX_URL_LEN: usize = 7500;
const PENDING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 3600);
const TITLE_MAX: usize = 120;

// ---------------------------------------------------------------- files

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    pid: u32,
    started_at: u64,
    version: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanicInfo {
    pub message: String,
    pub location: String,
    pub thread: String,
}

#[derive(Serialize, Deserialize)]
struct PanicFile {
    message: String,
    location: String,
    thread: String,
    at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeInfo {
    pub exception_code: String,
    pub exception_name: String,
    pub module: String,
    pub module_version: String,
    pub offset: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub id: String,
    pub version: String,
    pub os: Option<String>,
    pub arch: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_gb: f64,
    pub avx2: Option<bool>,
    pub avx512: Option<bool>,
    pub started_at: u64,
    pub crashed_at: Option<u64>,
    /// "panic" or "native".
    pub kind: String,
    pub panic: Option<PanicInfo>,
    pub native: Option<NativeInfo>,
    pub signature: String,
    pub title: String,
    pub body: String,
}

/// What an agent concluded about a crash, attached to its report by the
/// `attach_crash_diagnosis` tool. Every text is already scrubbed and clamped.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    /// "machine", "flowcode" or "unknown".
    pub verdict: String,
    /// 0..1.
    pub confidence: f64,
    pub title: String,
    pub summary: String,
    pub evidence: Vec<String>,
    pub local_fix: Vec<String>,
    pub repro_steps: Vec<String>,
    /// An open issue with the same crash, when the agent found one.
    pub existing_issue: Option<u32>,
    /// The agent that investigated (its id, for the badge).
    pub agent: String,
    pub at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCrash {
    pub report: CrashReport,
    pub other_count: usize,
    /// The agent's diagnosis of `report`, once it attached one; its section is in `report.body`.
    pub diagnosis: Option<Diagnosis>,
    /// The crash folder, where a diagnosis chat works.
    pub dir: String,
    /// The memory watch's log, when there is one.
    pub memory_log: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn marker_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("session-{pid}.json"))
}

fn panic_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("panic-{pid}.json"))
}

/// Writes through a temp file so a crash mid-write never leaves half a JSON.
fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(value).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn pending_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("pending-") && n.ends_with(".json"))
        })
        .collect()
}

fn diagnosis_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("diagnosis-{id}.json"))
}

fn read_muted(dir: &Path) -> Vec<String> {
    read_json(&dir.join("muted.json")).unwrap_or_default()
}

// ---------------------------------------------------------------- session

/// Called from `setup`: records this session and, in the background, looks for
/// sessions that ended without cleaning up.
pub fn init(app: &tauri::AppHandle) {
    let Ok(base) = app.path().app_data_dir() else { return };
    let dir = base.join("crash");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = CRASH_DIR.set(dir.clone());
    let pid = std::process::id();
    let marker = Marker { pid, started_at: now_ms(), version: env!("CARGO_PKG_VERSION").to_string() };
    let _ = write_json(&marker_path(&dir, pid), &marker);
    // remote/lifecycle.rs writes remote.log under app_config_dir, not app_data_dir.
    let log_dir = app.path().app_config_dir().unwrap_or(base);
    std::thread::spawn(move || detect(&dir, &log_dir, pid));
}

/// Clean exit: nothing to report. Also drops a panic file a caught panic (debug
/// builds unwind) may have left, which would otherwise sit around forever.
pub fn end_session() {
    let Some(dir) = CRASH_DIR.get() else { return };
    let pid = std::process::id();
    let _ = std::fs::remove_file(marker_path(dir, pid));
    let _ = std::fs::remove_file(panic_path(dir, pid));
}

/// Chains the previous hook (so the usual stderr message still appears) after
/// recording the panic. Runs before the abort, so this is the only moment the
/// message and location are still available. Must never panic itself.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        write_panic_file(&message, &location, &thread);
        previous(info);
    }));
}

fn write_panic_file(message: &str, location: &str, thread: &str) {
    let Some(dir) = CRASH_DIR.get() else { return };
    let file = PanicFile {
        message: message.to_string(),
        location: location.to_string(),
        thread: thread.to_string(),
        at: now_ms(),
    };
    let _ = write_json(&panic_path(dir, std::process::id()), &file);
}

// ---------------------------------------------------------------- detection

fn detect(dir: &Path, app_data: &Path, own_pid: u32) {
    // Old reports nobody acted on are stale; drop them.
    for p in pending_files(dir) {
        let old = std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > PENDING_MAX_AGE);
        if old {
            let _ = std::fs::remove_file(p);
        }
    }
    drop_orphan_diagnoses(dir);

    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let markers: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("session-") && n.ends_with(".json"))
        })
        .collect();
    if markers.is_empty() {
        return;
    }
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let muted = read_muted(dir);
    // The Event Log query spawns a process; do it at most once, and only if needed.
    let mut events: Option<Vec<AppErrorEvent>> = None;

    // Dead sessions with no evidence yet. Windows Error Reporting writes the
    // Event Log entry a few seconds after the crash, so a relaunch right away
    // can get here first: look once more before giving up on them.
    let mut undecided: Vec<(PathBuf, Marker)> = Vec::new();

    for path in markers {
        let Some(marker) = read_json::<Marker>(&path) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if marker.pid == own_pid {
            continue;
        }
        // Several Flowcode windows/processes can run at once: a marker whose
        // process is still alive (same name, same start time, so not a reused
        // pid) belongs to a healthy instance.
        // The marker is written after the process started (webview/setup
        // delay), so the OS start time lies shortly BEFORE `started_at`.
        let alive = sys.process(Pid::from_u32(marker.pid)).is_some_and(|p| {
            let delta = p.start_time() as i64 - (marker.started_at / 1000) as i64;
            p.name().to_string_lossy().to_ascii_lowercase().contains("flowcode")
                && (-120..=2).contains(&delta)
        });
        if alive {
            continue;
        }

        let events = events.get_or_insert_with(query_app_error_events);
        if !settle(dir, app_data, &marker, events, &muted) && cfg!(windows) {
            undecided.push((path, marker));
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }

    if undecided.is_empty() {
        return;
    }
    std::thread::sleep(std::time::Duration::from_secs(20));
    let events = query_app_error_events();
    for (path, marker) in undecided {
        settle(dir, app_data, &marker, &events, &muted);
        let _ = std::fs::remove_file(&path);
    }
}

/// Writes a pending report for a dead session if there is evidence of a crash
/// (a panic file or a matching Event Log entry). Returns whether there was.
/// The marker itself is left to the caller.
fn settle(dir: &Path, app_data: &Path, marker: &Marker, events: &[AppErrorEvent], muted: &[String]) -> bool {
    let panic_file = panic_path(dir, marker.pid);
    let panic = read_json::<PanicFile>(&panic_file);
    // An event older than the session belongs to an earlier process that
    // had the same pid.
    let native = events
        .iter()
        .find(|e| e.process_id == Some(marker.pid) && e.time_ms.is_none_or(|t| t + 5000 >= marker.started_at))
        .cloned();
    if panic.is_none() && native.is_none() {
        return false;
    }
    let report = build_report(marker, panic, native, &app_data.join("remote.log"));
    if !muted.contains(&report.signature) {
        let _ = write_json(&dir.join(format!("pending-{}.json", report.id)), &report);
    }
    let _ = std::fs::remove_file(&panic_file);
    true
}

// ---------------------------------------------------------------- Event Log

#[derive(Clone, Debug, Default, PartialEq)]
struct AppErrorEvent {
    time_ms: Option<u64>,
    app_name: String,
    app_version: String,
    module_name: String,
    module_version: String,
    exception_code: String,
    fault_offset: String,
    process_id: Option<u32>,
}

#[cfg(windows)]
fn query_app_error_events() -> Vec<AppErrorEvent> {
    use std::os::windows::process::CommandExt;
    let query = "*[System[Provider[@Name='Application Error'] and (EventID=1000) and TimeCreated[timediff(@SystemTime) <= 1209600000]]]";
    let mut cmd = std::process::Command::new("wevtutil");
    cmd.args(["qe", "Application"])
        .arg(format!("/q:{query}"))
        .args(["/f:xml", "/rd:true", "/c:100"])
        .creation_flags(flowcode_shared::CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else { return Vec::new() };
    let xml = String::from_utf8_lossy(&out.stdout);
    parse_app_error_events(&xml)
        .into_iter()
        .filter(|e| e.app_name.eq_ignore_ascii_case("flowcode.exe"))
        .collect()
}

#[cfg(not(windows))]
fn query_app_error_events() -> Vec<AppErrorEvent> {
    Vec::new()
}

fn decode_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Value of `name='...'` / `name="..."` inside one tag's text.
fn xml_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let at = tag.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[at..];
    let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let rest = &rest[1..];
    Some(&rest[..rest.find(quote)?])
}

/// Hand-rolled parse of `wevtutil ... /f:xml` output (one `<Event>` per entry).
/// `<Data>` values are read by position, since the `Name` attribute is absent
/// on some Windows builds: 0 AppName, 1 AppVersion, 3 ModuleName,
/// 4 ModuleVersion, 6 ExceptionCode, 7 FaultingOffset, 8 ProcessId.
fn parse_app_error_events(xml: &str) -> Vec<AppErrorEvent> {
    let mut out = Vec::new();
    for segment in xml.split("</Event>") {
        // `<Event` also prefixes `<EventData>`, `<EventID>`...: the real opening
        // tag is the one followed by whitespace or '>'.
        let Some(chunk) = segment
            .match_indices("<Event")
            .map(|(i, _)| &segment[i + 6..])
            .find(|r| r.starts_with([' ', '>', '\n', '\r', '\t']))
        else {
            continue;
        };
        let time_ms = chunk.find("<TimeCreated").and_then(|i| {
            let tag = &chunk[i..];
            let tag = &tag[..tag.find('>')?];
            parse_iso_ms(xml_attr(tag, "SystemTime")?)
        });
        let mut data: Vec<String> = Vec::new();
        let mut rest = chunk;
        while let Some(i) = rest.find("<Data") {
            rest = &rest[i + 5..];
            if !rest.starts_with([' ', '>', '/']) {
                continue;
            }
            let Some(end) = rest.find('>') else { break };
            if rest[..end].ends_with('/') {
                data.push(String::new());
                rest = &rest[end + 1..];
            } else {
                let body = &rest[end + 1..];
                let close = body.find("</Data>").unwrap_or(body.len());
                data.push(decode_xml(&body[..close]));
                rest = &body[close..];
            }
        }
        if data.len() < 9 {
            continue;
        }
        let get = |i: usize| data.get(i).cloned().unwrap_or_default();
        let pid = get(8);
        let process_id = pid
            .strip_prefix("0x")
            .or_else(|| pid.strip_prefix("0X"))
            .map(|h| u32::from_str_radix(h, 16).ok())
            .unwrap_or_else(|| pid.parse().ok());
        out.push(AppErrorEvent {
            time_ms,
            app_name: get(0),
            app_version: get(1),
            module_name: get(3),
            module_version: get(4),
            exception_code: get(6),
            fault_offset: get(7),
            process_id,
        });
    }
    out
}

/// "2026-11-17T10:20:30.1234567Z" -> unix ms.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
    let days = days_from_civil(y, m, day);
    let total = ((days * 24 + hh) * 60 + mm) * 60 + ss;
    u64::try_from(total * 1000 + ms).ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

fn format_utc(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn format_uptime(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}h {}m {}s", s / 3600, s % 3600 / 60, s % 60)
}

// ---------------------------------------------------------------- report

fn exception_name(code: &str) -> &'static str {
    match code.strip_prefix("0x").unwrap_or(code) {
        "c0000005" => "Access violation",
        "c000001d" => "Illegal instruction (CPU feature not supported)",
        "c0000409" => "Fail-fast / abort (Rust panic, failed allocation or stack buffer overrun)",
        "c00000fd" => "Stack overflow",
        "c0000374" => "Heap corruption",
        "80000003" => "Breakpoint",
        "c0000094" => "Integer divide by zero",
        _ => "Unknown exception",
    }
}

/// "C000001D" / "0xC000001D" -> "0xc000001d".
fn normalize_code(raw: &str) -> String {
    let t = raw.trim();
    let hex = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    match u32::from_str_radix(hex, 16) {
        Ok(n) => format!("0x{n:08x}"),
        Err(_) => format!("0x{}", hex.to_ascii_lowercase()),
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn cpu_features() -> (Option<bool>, Option<bool>) {
    (Some(is_x86_feature_detected!("avx2")), Some(is_x86_feature_detected!("avx512f")))
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn cpu_features() -> (Option<bool>, Option<bool>) {
    (None, None)
}

fn last_lines(path: &Path, n: usize) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(n)..].join("\n");
    (!tail.trim().is_empty()).then_some(tail)
}

fn build_report(
    marker: &Marker,
    panic: Option<PanicFile>,
    native: Option<AppErrorEvent>,
    log_path: &Path,
) -> CrashReport {
    let ctx = ScrubCtx::from_env();
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let ram_gb = (sys.total_memory() as f64 / 1_073_741_824.0 * 10.0).round() / 10.0;
    let (avx2, avx512) = cpu_features();

    let panic_info = panic.as_ref().map(|p| PanicInfo {
        message: scrub(&p.message, &ctx),
        location: scrub(&p.location, &ctx),
        thread: scrub(&p.thread, &ctx),
    });
    let native_info = native.as_ref().map(|e| {
        let code = normalize_code(&e.exception_code);
        NativeInfo {
            exception_name: exception_name(&code).to_string(),
            exception_code: code,
            module: e.module_name.clone(),
            module_version: e.module_version.clone(),
            offset: e.fault_offset.clone(),
        }
    });
    let crashed_at = panic.as_ref().map(|p| p.at).or_else(|| native.as_ref().and_then(|e| e.time_ms));
    let kind = if panic_info.is_some() { "panic" } else { "native" };
    let version = marker.version.clone();

    let (signature, title) = match (&panic_info, &native_info) {
        (Some(p), _) => (
            format!("panic@{}", p.location),
            format!("Crash: panic at {} (v{version})", p.location),
        ),
        (None, Some(n)) => {
            let short = n.exception_name.split(" (").next().unwrap_or(&n.exception_name);
            (
                format!("{}@{}+{}", n.exception_code, n.module, n.offset).to_lowercase(),
                format!("Crash: {short} in {} (v{version})", n.module),
            )
        }
        // Unreachable: callers only build a report with some evidence.
        (None, None) => ("unknown".to_string(), format!("Crash (v{version})")),
    };

    let mut body = String::from("### What happened\n");
    body.push_str(&format!("- Kind: {kind}\n"));
    if let Some(t) = crashed_at {
        body.push_str(&format!("- Time: {}\n", format_utc(t)));
        if t >= marker.started_at {
            body.push_str(&format!("- Uptime: {}\n", format_uptime(t - marker.started_at)));
        }
    }
    body.push_str("\n### Error\n");
    if let Some(p) = &panic_info {
        body.push_str(&format!(
            "- Message: {}\n- Location: `{}`\n- Thread: {}\n",
            p.message, p.location, p.thread
        ));
    }
    if let Some(n) = &native_info {
        body.push_str(&format!(
            "- Exception: `{}` ({})\n- Module: {} {}\n- Offset: `{}`\n",
            n.exception_code, n.exception_name, n.module, n.module_version, n.offset
        ));
    }
    let yn = |v: Option<bool>| match v {
        Some(true) => "yes",
        Some(false) => "no",
        None => "n/a",
    };
    body.push_str(&format!(
        "\n### System\n- Flowcode: {version}\n- OS: {}\n- Arch: {}\n- CPU: {}\n- Cores: {}\n- RAM: {ram_gb} GB\n- AVX2: {}\n- AVX-512: {}\n",
        sys_os(),
        std::env::consts::ARCH,
        cpu,
        sys.cpus().len(),
        yn(avx2),
        yn(avx512),
    ));
    if let Some(log) = last_lines(log_path, 20) {
        body.push_str(&format!("\n### Recent log\n```\n{log}\n```\n"));
    }
    body.push_str(&format!(
        "\n### Signature\n`{signature}`\n\n<!-- flowcode-crash-signature: {signature} -->"
    ));

    let mut title = scrub(&title, &ctx);
    if title.chars().count() > TITLE_MAX {
        title = title.chars().take(TITLE_MAX).collect();
    }
    CrashReport {
        id: uuid::Uuid::new_v4().to_string(),
        version,
        os: System::long_os_version(),
        arch: std::env::consts::ARCH.to_string(),
        cpu,
        cores: sys.cpus().len(),
        ram_gb,
        avx2,
        avx512,
        started_at: marker.started_at,
        crashed_at,
        kind: kind.to_string(),
        panic: panic_info,
        native: native_info,
        signature: scrub(&signature, &ctx),
        title,
        body: scrub(&body, &ctx),
    }
}

fn sys_os() -> String {
    System::long_os_version().unwrap_or_else(|| "unknown".to_string())
}

// ---------------------------------------------------------------- scrubbing

/// What identifies the user on this machine, removed from reports before they
/// are stored (and so before they can be pasted into a public issue).
struct ScrubCtx {
    home: Option<String>,
    user: Option<String>,
    host: Option<String>,
}

impl ScrubCtx {
    fn from_env() -> Self {
        let var = |names: &[&str]| {
            names.iter().find_map(|n| std::env::var(n).ok()).filter(|v| !v.trim().is_empty())
        };
        ScrubCtx {
            home: var(&["USERPROFILE", "HOME"]),
            user: var(&["USERNAME", "USER"]),
            host: var(&["COMPUTERNAME", "HOSTNAME"]).or_else(System::host_name),
        }
    }
}

/// Replaces every occurrence of `needle`. `word` additionally requires that the
/// match is not glued to letters or digits (so a user called "ann" does not
/// eat "channel"). Lowercasing ASCII keeps byte offsets, so indices found in
/// the lowered copy are valid in the original.
fn replace_all(text: &str, needle: &str, with: &str, ci: bool, word: bool) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let (hay, nd) = if ci {
        (text.to_ascii_lowercase(), needle.to_ascii_lowercase())
    } else {
        (text.to_string(), needle.to_string())
    };
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while let Some(i) = hay[pos..].find(&nd) {
        let start = pos + i;
        let end = start + nd.len();
        let glued = word
            && (text[..start].chars().next_back().is_some_and(|c| c.is_alphanumeric())
                || text[end..].chars().next().is_some_and(|c| c.is_alphanumeric()));
        if glued {
            let step = text[start..].chars().next().map_or(1, |c| c.len_utf8());
            out.push_str(&text[pos..start + step]);
            pos = start + step;
        } else {
            out.push_str(&text[pos..start]);
            out.push_str(with);
            pos = end;
        }
    }
    out.push_str(&text[pos..]);
    out
}

/// Masks every run of 32+ characters that looks like a hash, key or token.
/// Requires a digit so long identifiers and plain words survive.
fn redact_long_runs(token: &str) -> String {
    let is_run = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'=' | b'_' | b'-');
    let bytes = token.as_bytes();
    let mut out = String::with_capacity(token.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if is_run(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_run(bytes[i]) {
                i += 1;
            }
            if i - start >= 32 && bytes[start..i].iter().any(|b| b.is_ascii_digit()) {
                out.push_str(&token[copied..start]);
                out.push_str("<redacted>");
                copied = i;
            }
        } else {
            i += 1;
        }
    }
    out.push_str(&token[copied..]);
    out
}

/// Whether `run` (hex digits, '.' and ':' only) is an IPv4/IPv6 address,
/// optionally with an IPv4 `:port`. Addresses starting with 0 (such as the
/// four-part module version "0.36.0.0") are left alone.
fn is_ip_run(run: &str) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    let v4 = |s: &str| s.parse::<Ipv4Addr>().is_ok_and(|a| a.octets()[0] != 0);
    // The digit requirement keeps Rust paths such as "bad::dec" intact.
    if v4(run) || (run.bytes().any(|b| b.is_ascii_digit()) && run.parse::<Ipv6Addr>().is_ok()) {
        return true;
    }
    run.rsplit_once(':').is_some_and(|(host, port)| {
        !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) && v4(host)
    })
}

/// Replaces IPv4 / IPv6 addresses (and IPv4 host:port) with `<ip>`.
fn redact_ips(token: &str) -> String {
    let is_ip_char = |b: u8| b.is_ascii_hexdigit() || b == b'.' || b == b':';
    let bytes = token.as_bytes();
    let mut out = String::with_capacity(token.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if !is_ip_char(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_ip_char(bytes[i]) {
            i += 1;
        }
        // Trailing sentence punctuation is not part of the address.
        // Likewise a leading separator ("addr:1.2.3.4").
        let mut s = start;
        loop {
            let mut end = i;
            let mut hit = false;
            loop {
                if is_ip_run(&token[s..end]) {
                    hit = true;
                    break;
                }
                if end > s && matches!(bytes[end - 1], b'.' | b':') {
                    end -= 1;
                } else {
                    break;
                }
            }
            if hit {
                out.push_str(&token[copied..s]);
                out.push_str("<ip>");
                copied = end;
                break;
            }
            if s < i && matches!(bytes[s], b'.' | b':') {
                s += 1;
            } else {
                break;
            }
        }
    }
    out.push_str(&token[copied..]);
    out
}

fn scrub_token(token: &str) -> String {
    if let Some(at) = token.find('@') {
        if token[at..].contains('.') {
            return "<email>".to_string();
        }
    }
    redact_long_runs(&redact_ips(token))
}

fn scrub(text: &str, ctx: &ScrubCtx) -> String {
    let ci = cfg!(windows);
    let mut s = text.to_string();
    if let Some(home) = &ctx.home {
        let home = home.trim_end_matches(['\\', '/']);
        s = replace_all(&s, home, "~", ci, false);
        s = replace_all(&s, &home.replace('\\', "/"), "~", ci, false);
    }
    if let Some(host) = &ctx.host {
        s = replace_all(&s, host, "<host>", true, true);
    }
    if let Some(user) = &ctx.user {
        s = replace_all(&s, user, "<user>", true, true);
    }
    // Token pass; whitespace is kept exactly as it was.
    let mut out = String::with_capacity(s.len());
    let mut token = String::new();
    for c in s.chars() {
        if c.is_whitespace() {
            out.push_str(&scrub_token(&token));
            token.clear();
            out.push(c);
        } else {
            token.push(c);
        }
    }
    out.push_str(&scrub_token(&token));
    out
}

// ---------------------------------------------------------------- diagnosis

const DIAGNOSIS_TITLE_MAX: usize = 80;
const DIAGNOSIS_SUMMARY_MAX: usize = 1200;
const DIAGNOSIS_ITEM_MAX: usize = 300;
const EVIDENCE_MAX: usize = 10;
const LOCAL_FIX_MAX: usize = 8;
const REPRO_MAX: usize = 10;
const ISSUE_NUMBER_MAX: u64 = 10_000_000;

fn clamp_text(text: &str, max: usize, ctx: &ScrubCtx) -> String {
    scrub(text.trim().chars().take(max).collect::<String>().trim(), ctx)
}

/// A list of short strings: the non-empty ones, at most `count`, each cut to `DIAGNOSIS_ITEM_MAX`.
fn clamp_list(value: Option<&serde_json::Value>, count: usize, ctx: &ScrubCtx) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(|s| clamp_text(s, DIAGNOSIS_ITEM_MAX, ctx))
        .filter(|s| !s.is_empty())
        .take(count)
        .collect()
}

/// Checks and clamps the arguments of `attach_crash_diagnosis`; the texts are scrubbed like the report's.
fn parse_diagnosis(args: &serde_json::Value, agent: &str, ctx: &ScrubCtx, at: u64) -> Result<Diagnosis, String> {
    let verdict = args.get("verdict").and_then(|v| v.as_str()).unwrap_or_default();
    if !matches!(verdict, "machine" | "flowcode" | "unknown") {
        return Err("`verdict` must be \"machine\", \"flowcode\" or \"unknown\"".to_string());
    }
    let confidence = args
        .get("confidence")
        .and_then(|v| v.as_f64())
        .filter(|c| c.is_finite())
        .ok_or("`confidence` must be a number between 0 and 1")?
        .clamp(0.0, 1.0);
    let text = |key: &str, max: usize| clamp_text(args.get(key).and_then(|v| v.as_str()).unwrap_or_default(), max, ctx);
    let title = text("title", DIAGNOSIS_TITLE_MAX);
    let summary = text("summary", DIAGNOSIS_SUMMARY_MAX);
    if title.is_empty() || summary.is_empty() {
        return Err("`title` and `summary` are required".to_string());
    }
    let existing_issue = args
        .get("existing_issue")
        .and_then(|v| v.as_u64())
        .filter(|n| (1..=ISSUE_NUMBER_MAX).contains(n))
        .map(|n| n as u32);
    Ok(Diagnosis {
        verdict: verdict.to_string(),
        confidence,
        title,
        summary,
        evidence: clamp_list(args.get("evidence"), EVIDENCE_MAX, ctx),
        local_fix: clamp_list(args.get("local_fix"), LOCAL_FIX_MAX, ctx),
        repro_steps: clamp_list(args.get("repro_steps"), REPRO_MAX, ctx),
        existing_issue,
        agent: agent.to_string(),
        at,
    })
}

/// The `### Agent diagnosis` section of the issue body.
fn diagnosis_section(d: &Diagnosis) -> String {
    let verdict = match (d.existing_issue, d.verdict.as_str()) {
        (Some(n), _) => format!("already reported (#{n})"),
        (None, "machine") => "problem with this computer".to_string(),
        (None, "flowcode") => "probable Flowcode bug".to_string(),
        _ => "undetermined".to_string(),
    };
    let mut out = format!(
        "### Agent diagnosis\n- Verdict: {verdict}\n- Confidence: {}%\n- Agent: {}\n\n**{}**\n\n{}\n",
        (d.confidence * 100.0).round() as u32,
        d.agent,
        d.title,
        d.summary
    );
    let list = |out: &mut String, heading: &str, items: &[String], numbered: bool| {
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("\n{heading}\n"));
        for (i, item) in items.iter().enumerate() {
            if numbered {
                out.push_str(&format!("{}. {item}\n", i + 1));
            } else {
                out.push_str(&format!("- {item}\n"));
            }
        }
    };
    list(&mut out, "Evidence:", &d.evidence, false);
    list(&mut out, "Possible local fix:", &d.local_fix, false);
    list(&mut out, "Steps to reproduce:", &d.repro_steps, true);
    out
}

/// `body` with the diagnosis section in front of its signature (the part a duplicate search keys on).
fn insert_diagnosis(body: &str, d: &Diagnosis) -> String {
    let section = diagnosis_section(d);
    match body.find("\n### Signature") {
        Some(i) => format!("{}\n{section}{}", &body[..i], &body[i..]),
        None => format!("{body}\n\n{section}"),
    }
}

/// Removes the diagnoses whose report is gone (dismissed or reported).
fn drop_orphan_diagnoses(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for path in rd.flatten().map(|e| e.path()) {
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("diagnosis-"))
            .and_then(|n| n.strip_suffix(".json"))
        else {
            continue;
        };
        if !dir.join(format!("pending-{id}.json")).exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Whether `id` is a report still waiting for the user (what a diagnosis chat may be started for).
pub(crate) fn report_pending(id: &str) -> bool {
    valid_id(id) && crash_dir().is_ok_and(|dir| dir.join(format!("pending-{id}.json")).is_file())
}

/// The `attach_crash_diagnosis` tool of the diagnosis chat of report `id`: stores the checked diagnosis next to
/// the report (a second call replaces the first) and tells the window (`crash-diagnosis`).
pub(crate) fn attach_diagnosis(app: &tauri::AppHandle, id: &str, agent: &str, args: &serde_json::Value) -> Result<String, String> {
    if !report_pending(id) {
        return Err("this crash report no longer exists".to_string());
    }
    let dir = crash_dir()?;
    let diagnosis = parse_diagnosis(args, agent, &ScrubCtx::from_env(), now_ms())?;
    write_json(&diagnosis_path(dir, id), &diagnosis).map_err(|e| e.to_string())?;
    let _ = app.emit("crash-diagnosis", serde_json::json!({ "reportId": id }));
    Ok("The diagnosis was attached to the crash report. Now give the user a 2-3 sentence summary.".to_string())
}

// ---------------------------------------------------------------- issue URL

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn build_issue_url(title: &str, body: &str) -> String {
    let url = |b: &str| {
        format!("{ISSUE_URL}?title={}&body={}&labels=crash", percent_encode(title), percent_encode(b))
    };
    let full = url(body);
    if full.len() <= MAX_URL_LEN {
        return full;
    }
    // First drop the log section, the bulkiest and least essential part.
    let mut body = body.to_string();
    if let Some(i) = body.find("### Recent log") {
        let end = body[i + 3..].find("\n### ").map_or(body.len(), |j| i + 3 + j + 1);
        body.replace_range(i..end, "");
    }
    const NOTE: &str = "\n\n_(truncated)_";
    let candidate = url(&body);
    if candidate.len() <= MAX_URL_LEN {
        return candidate;
    }
    let budget = MAX_URL_LEN.saturating_sub(url(NOTE).len());
    let mut kept = String::new();
    let mut used = url("").len();
    for c in body.chars() {
        let cost = percent_encode(c.encode_utf8(&mut [0; 4])).len();
        if used + cost > budget {
            break;
        }
        used += cost;
        kept.push(c);
    }
    kept.push_str(NOTE);
    url(&kept)
}

// ---------------------------------------------------------------- commands

fn crash_dir() -> Result<&'static PathBuf, String> {
    CRASH_DIR.get().ok_or_else(|| "crash directory not initialised".to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f' | '-'))
}

/// Newest unshown report plus how many more are waiting. Does not delete: the
/// frontend dismisses explicitly once the user has acted.
#[tauri::command]
pub async fn crash_pending() -> Result<Option<PendingCrash>, String> {
    crate::blocking(|| {
        let dir = crash_dir()?;
        let mut reports: Vec<CrashReport> =
            pending_files(dir).iter().filter_map(|p| read_json::<CrashReport>(p)).collect();
        reports.sort_by_key(|r| r.crashed_at.unwrap_or(r.started_at));
        let other_count = reports.len().saturating_sub(1);
        Ok(reports.pop().map(|mut report| {
            let diagnosis = read_json::<Diagnosis>(&diagnosis_path(dir, &report.id));
            if let Some(d) = &diagnosis {
                report.body = insert_diagnosis(&report.body, d);
            }
            let memory_log = dir.parent().map(|p| p.join("memory.log")).filter(|p| p.is_file());
            PendingCrash {
                report,
                other_count,
                diagnosis,
                dir: dir.to_string_lossy().into_owned(),
                memory_log: memory_log.map(|p| p.to_string_lossy().into_owned()),
            }
        }))
    })
    .await
}

#[tauri::command]
pub async fn crash_dismiss(id: String, mute: bool) -> Result<(), String> {
    crate::blocking(move || {
        if !valid_id(&id) {
            return Err("invalid crash id".to_string());
        }
        let dir = crash_dir()?;
        let path = dir.join(format!("pending-{id}.json"));
        if mute {
            if let Some(report) = read_json::<CrashReport>(&path) {
                let mut muted = read_muted(dir);
                if !muted.contains(&report.signature) {
                    muted.push(report.signature);
                    write_json(&dir.join("muted.json"), &muted).map_err(|e| e.to_string())?;
                }
            }
        }
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(diagnosis_path(dir, &id));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn crash_dismiss_all() -> Result<(), String> {
    crate::blocking(|| {
        let dir = crash_dir()?;
        for p in pending_files(dir) {
            let _ = std::fs::remove_file(p);
        }
        drop_orphan_diagnoses(dir);
        Ok(())
    })
    .await
}

/// Prefilled "new issue" page for a report. Pure string work, so a plain sync
/// command is fine.
#[tauri::command]
pub fn crash_issue_url(title: String, body: String) -> String {
    build_issue_url(&title, &body)
}

/// Debug-only way to produce a crash on purpose. Debug builds unwind on panic,
/// so rather than panicking this writes what the hook would have written and
/// aborts, leaving the session marker behind just as a real release crash does.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn crash_simulate(kind: String) -> Result<(), String> {
    if kind == "panic" {
        write_panic_file("simulated crash", "src/crash.rs:0:0", "main");
    }
    std::process::abort();
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads this machine's real Event Log; run by hand with
    /// `cargo test crash::tests::live_event_log -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_event_log() {
        for e in query_app_error_events() {
            println!("{e:?}");
        }
    }

    const SAMPLE: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-11-17T10:20:30.1234567Z'/></System><EventData><Data>flowcode.exe</Data><Data>0.36.0.0</Data><Data>6740b1c2</Data><Data>flowcode.exe</Data><Data>0.36.0.0</Data><Data>6740b1c2</Data><Data>c000001d</Data><Data>00000000012a4f10</Data><Data>0x30b8</Data><Data>01dbf3c2a1b2c3d4</Data><Data>C:\Users\a &amp; b\AppData\Local\Flowcode\flowcode.exe</Data><Data/></EventData></Event>
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><TimeCreated SystemTime="2026-11-16T01:02:03Z"/></System><EventData><Data Name="AppName">other.exe</Data><Data Name="AppVersion">1</Data><Data/><Data Name="ModuleName">ntdll.dll</Data><Data>10.0</Data><Data/><Data>c0000005</Data><Data>1234</Data><Data>0x10</Data></EventData></Event>"#;

    #[test]
    fn parses_events() {
        let ev = parse_app_error_events(SAMPLE);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].app_name, "flowcode.exe");
        assert_eq!(ev[0].exception_code, "c000001d");
        assert_eq!(ev[0].fault_offset, "00000000012a4f10");
        assert_eq!(ev[0].process_id, Some(0x30b8));
        assert_eq!(ev[0].time_ms, Some(1_794_910_830_123));
        assert_eq!(ev[1].app_name, "other.exe");
        assert_eq!(ev[1].module_name, "ntdll.dll");
        assert_eq!(ev[1].process_id, Some(16));
        assert_eq!(decode_xml("a &amp; b &lt;&gt;&quot;&apos;"), "a & b <>\"'");
    }

    #[test]
    fn time_formatting_roundtrip() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(format_utc(1_794_910_830_123), "2026-11-17 10:20:30 UTC");
        assert_eq!(format_uptime(3_725_000), "1h 2m 5s");
    }

    #[test]
    fn code_names() {
        assert_eq!(normalize_code("C000001D"), "0xc000001d");
        assert_eq!(exception_name("0xc000001d"), "Illegal instruction (CPU feature not supported)");
        assert_eq!(exception_name("0x12345678"), "Unknown exception");
    }

    fn ctx() -> ScrubCtx {
        ScrubCtx {
            home: Some(r"C:\Users\massi".to_string()),
            user: Some("massi".to_string()),
            host: Some("DESKTOP-ABC".to_string()),
        }
    }

    #[test]
    fn scrubs_personal_data() {
        let c = ctx();
        let s = scrub(r"open c:\users\MASSI\x.rs and C:/Users/massi/y.rs", &c);
        assert_eq!(s, "open ~\\x.rs and ~/y.rs");
        assert_eq!(scrub("user massi on desktop-abc", &c), "user <user> on <host>");
        assert_eq!(scrub("massive massimo", &c), "massive massimo");
        assert_eq!(scrub("mail me at a.b@example.com now", &c), "mail me at <email> now");
        let hash = "0123456789abcdef0123456789abcdef0123";
        assert_eq!(scrub(&format!("key: {hash} ok"), &c), "key: <redacted> ok");
        assert_eq!(scrub("short abc123 and a_very_long_identifier_without_digits_in_it", &c),
            "short abc123 and a_very_long_identifier_without_digits_in_it");
        assert_eq!(scrub("line1\n  line2", &c), "line1\n  line2");
    }

    #[test]
    fn scrubs_ip_addresses() {
        let c = ctx();
        assert_eq!(scrub("peer 192.168.1.20:8080 down", &c), "peer <ip> down");
        assert_eq!(scrub("connect(10.0.0.5).", &c), "connect(<ip>).");
        assert_eq!(scrub("addr:1.2.3.4, x", &c), "addr:<ip>, x");
        assert_eq!(scrub("v6 2001:db8::ff00:42:8329 and ::1 and [fe80::1]:443", &c), "v6 <ip> and <ip> and [<ip>]:443");
        assert_eq!(scrub("http://203.0.113.9:80/x", &c), "http://<ip>/x");
        // Versions and source locations survive.
        assert_eq!(scrub("flowcode.exe 0.36.0.0 at src/a.rs:12:5 v10.0.26300.1", &c), "flowcode.exe 0.36.0.0 at src/a.rs:12:5 v10.0.26300.1");
    }


    fn sample_args() -> serde_json::Value {
        serde_json::json!({
            "verdict": "machine",
            "confidence": 1.7,
            "title": "Driver video NVIDIA",
            "summary": "Crash in nvoglv64.dll for massi on DESKTOP-ABC",
            "evidence": ["a", "  ", "b"],
            "local_fix": ["Aggiorna il driver"],
            "repro_steps": [],
            "existing_issue": 214,
        })
    }

    #[test]
    fn diagnosis_is_validated_clamped_and_scrubbed() {
        let c = ctx();
        let d = parse_diagnosis(&sample_args(), "claude", &c, 5).unwrap();
        assert_eq!(d.confidence, 1.0);
        assert_eq!(d.summary, "Crash in nvoglv64.dll for <user> on <host>");
        assert_eq!(d.evidence, ["a", "b"]);
        assert_eq!((d.existing_issue, d.agent.as_str(), d.at), (Some(214), "claude", 5));

        let mut bad = sample_args();
        bad["verdict"] = "duplicate".into();
        assert!(parse_diagnosis(&bad, "claude", &c, 0).is_err());
        let mut bad = sample_args();
        bad["confidence"] = "high".into();
        assert!(parse_diagnosis(&bad, "claude", &c, 0).is_err());
        let mut bad = sample_args();
        bad["summary"] = "  ".into();
        assert!(parse_diagnosis(&bad, "claude", &c, 0).is_err());

        let mut long = sample_args();
        long["title"] = "t".repeat(200).into();
        long["summary"] = "s".repeat(5000).into();
        long["evidence"] = serde_json::Value::Array((0..30).map(|_| "e".repeat(900).into()).collect());
        long["existing_issue"] = 0.into();
        let d = parse_diagnosis(&long, "codex", &c, 0).unwrap();
        assert_eq!((d.title.len(), d.summary.len(), d.evidence.len()), (DIAGNOSIS_TITLE_MAX, DIAGNOSIS_SUMMARY_MAX, EVIDENCE_MAX));
        assert!(d.evidence.iter().all(|e| e.len() == DIAGNOSIS_ITEM_MAX));
        assert_eq!(d.existing_issue, None);
    }

    #[test]
    fn diagnosis_section_goes_before_the_signature() {
        let d = parse_diagnosis(&sample_args(), "claude", &ctx(), 0).unwrap();
        let section = diagnosis_section(&d);
        assert!(section.starts_with("### Agent diagnosis\n- Verdict: already reported (#214)\n- Confidence: 100%\n- Agent: claude"));
        assert!(section.contains("Evidence:\n- a\n- b\n"));
        assert!(section.contains("Possible local fix:\n- Aggiorna il driver\n"));
        assert!(!section.contains("Steps to reproduce"));
        let body = "### What happened\nx\n\n### Signature\n`s`\n\n<!-- flowcode-crash-signature: s -->";
        let merged = insert_diagnosis(body, &d);
        assert!(merged.find("### Agent diagnosis").unwrap() < merged.find("### Signature").unwrap());
        assert!(merged.starts_with("### What happened\nx\n"));
        assert!(merged.ends_with("<!-- flowcode-crash-signature: s -->"));
        assert!(insert_diagnosis("no signature", &d).ends_with(&section));
    }

    #[test]
    fn encodes_percent() {
        assert_eq!(percent_encode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(percent_encode("a b&é"), "a%20b%26%C3%A9");
    }

    #[test]
    fn caps_url_length() {
        let short = build_issue_url("T", "body");
        assert_eq!(short, format!("{ISSUE_URL}?title=T&body=body&labels=crash"));

        let log = "x".repeat(9000);
        let body = format!("### What happened\nhi\n\n### Recent log\n```\n{log}\n```\n\n### Signature\n`s`");
        let url = build_issue_url("T", &body);
        assert!(url.len() <= MAX_URL_LEN);
        assert!(!url.contains("Recent%20log"));
        assert!(url.contains("Signature"));

        let huge = "é".repeat(20000);
        let url = build_issue_url("T", &huge);
        assert!(url.len() <= MAX_URL_LEN);
        assert!(url.contains("truncated"));
    }
}
