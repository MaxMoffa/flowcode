//! Self-update of the phone app from the public GitHub releases, mirroring the
//! desktop updater (src-tauri/src/updater.rs): `update_check` compares the
//! latest release with this build, `update_install` downloads the release's
//! `Flowcode-Android-<version>.apk` (progress streamed over a `Channel`),
//! verifies the Ed25519-signed `SHA256SUMS` and the APK against it, then
//! hands the file to Android's package installer (Kotlin `InstallPlugin`).
//!
//! Errors reach the webview as short codes (`updates.ts` turns them into
//! translated text), never as prose.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, State, Wry};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/MaxMoffa/flowcode/releases/latest";
const USER_AGENT: &str = concat!("flowcode-mobile/", env!("CARGO_PKG_VERSION"));
const CHECKSUMS_ASSET: &str = "SHA256SUMS";
const SIGNATURE_ASSET: &str = "SHA256SUMS.sig";
/// Every asset (APK, checksums, signature) must come from this repository's
/// release downloads, so a tampered API answer can't point the updater at
/// some other host.
const ASSET_URL_PREFIX: &str = "https://github.com/MaxMoffa/flowcode/releases/download/";
/// Subfolder of the app's cache dir the APK is stored in; the FileProvider's
/// `update_file_paths.xml` and `InstallPlugin.kt` both name it.
const UPDATE_DIR: &str = "updates";

/// Public half of the release signing key; copied from the desktop updater
/// (src-tauri/src/updater.rs), which documents where the private half lives.
/// `SHA256SUMS.sig` must be a valid Ed25519 signature over `SHA256SUMS`.
const RELEASE_PUBLIC_KEY: [u8; 32] = [
    0x32, 0xc7, 0xc0, 0xd9, 0x90, 0xc8, 0xa2, 0xc5, 0x8c, 0x08, 0xda, 0xef, 0xfc, 0xa7, 0x44, 0xae,
    0x7e, 0x91, 0x79, 0x32, 0xc4, 0x4f, 0xbd, 0xd1, 0x76, 0x84, 0xe0, 0xee, 0x43, 0x1e, 0x5f, 0x28,
];

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// What the Settings "Updates" section and the startup sheet show.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release's description (markdown), as written on GitHub.
    pub notes: String,
    pub page_url: String,
    pub size: u64,
}

/// The release `update_check` last found, with the download details the
/// webview never gets to choose.
struct PendingRelease {
    info: UpdateInfo,
    asset_name: String,
    asset_url: String,
    checksums_url: Option<String>,
    signature_url: Option<String>,
    /// The downloaded and verified APK, kept so a retry after the "install
    /// unknown apps" permission screen doesn't download it again.
    verified: Option<PathBuf>,
}

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<PendingRelease>>,
    /// An install is running: a second one would race on the same file.
    busy: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum UpdateProgress {
    Download { downloaded: u64, total: u64 },
    Verify,
}

/// How the hand-off to Android ended.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum InstallOutcome {
    /// The system installer is open.
    Started,
    /// Android's "install unknown apps" screen for this app was opened instead.
    NeedsPermission,
}

/// Bridge to the Kotlin `InstallPlugin`; elsewhere installing isn't possible.
#[derive(Clone)]
pub struct Installer {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct InstallPayload<'a> {
    path: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct InstallReply {
    status: InstallOutcome,
}

impl Installer {
    fn install(&self, path: &Path) -> Result<InstallOutcome, String> {
        #[cfg(target_os = "android")]
        return self
            .handle
            .run_mobile_plugin::<InstallReply>("installApk", InstallPayload { path: &path.to_string_lossy() })
            .map(|r| r.status)
            .map_err(|_| "installFailed".to_string());
        #[cfg(not(target_os = "android"))]
        {
            let _ = path;
            Err("androidOnly".into())
        }
    }
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("install")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "InstallPlugin")?;
                app.manage(Installer { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Installer {});
            }
            app.manage(UpdaterState::default());
            Ok(())
        })
        .build()
}

/// `major.minor.patch` of a tag or version string - a leading `v` and any
/// `-prerelease`/`+build` suffix are ignored.
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let core = raw.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
}

fn is_trusted_url(url: &str) -> bool {
    url.starts_with(ASSET_URL_PREFIX)
}

fn fetch_latest() -> Result<GhRelease, String> {
    let response = agent().get(LATEST_RELEASE_URL).set("Accept", "application/vnd.github+json").call().map_err(|e| match e {
        // Also what GitHub answers for a private repository.
        ureq::Error::Status(404, _) => "notFound",
        ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => "rateLimited",
        _ => "network",
    })?;
    serde_json::from_reader(response.into_reader()).map_err(|_| "network".to_string())
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map(|d| d.join(UPDATE_DIR)).map_err(|e| e.to_string())
}

/// `Some` when GitHub has a newer release than this build with an APK for
/// the phone, `None` when this build is up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String> {
    let release = tauri::async_runtime::spawn_blocking(fetch_latest).await.map_err(|e| e.to_string())??;

    let current = app.package_info().version.to_string();
    let (Some(latest), Some(installed)) = (parse_version(&release.tag_name), parse_version(&current)) else {
        return Err("badVersion".into());
    };
    if release.draft || release.prerelease || latest <= installed {
        *lock(&state.pending) = None;
        // An older download is no use now (and APKs are tens of MB).
        if !state.busy.load(Ordering::SeqCst) {
            if let Ok(dir) = update_dir(&app) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        return Ok(None);
    }
    let version = release.tag_name.trim_start_matches('v').to_string();
    let asset_name = format!("Flowcode-Android-{version}.apk");
    // A release without an APK (desktop-only) is no update for the phone.
    let Some(asset) = release.assets.iter().find(|a| a.name == asset_name) else {
        *lock(&state.pending) = None;
        return Ok(None);
    };
    if !is_trusted_url(&asset.browser_download_url) {
        return Err("untrusted".into());
    }
    let find_trusted = |name: &str| {
        release.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone()).filter(|u| is_trusted_url(u))
    };
    let info = UpdateInfo {
        version,
        current_version: current,
        notes: release.body.clone().unwrap_or_default(),
        page_url: release.html_url.clone(),
        size: asset.size,
    };
    *lock(&state.pending) = Some(PendingRelease {
        info: info.clone(),
        asset_name: asset.name.clone(),
        asset_url: asset.browser_download_url.clone(),
        checksums_url: find_trusted(CHECKSUMS_ASSET),
        signature_url: find_trusted(SIGNATURE_ASSET),
        verified: None,
    });
    Ok(Some(info))
}

fn download(url: &str, dest: &Path, expected_size: u64, on_progress: &Channel<UpdateProgress>) -> Result<String, String> {
    let failed = || "downloadFailed".to_string();
    let response = agent().get(url).timeout(Duration::from_secs(15 * 60)).call().map_err(|_| failed())?;
    let total = response.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(expected_size);
    let mut reader = response.into_reader();
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dest).map_err(|_| failed())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
    loop {
        let n = reader.read(&mut buf).map_err(|_| failed())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|_| failed())?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        if last_report.elapsed() >= Duration::from_millis(100) {
            last_report = Instant::now();
            let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
        }
    }
    file.flush().map_err(|_| failed())?;
    let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
    if total > 0 && downloaded != total {
        return Err("incomplete".into());
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.as_bytes();
    if s.len() % 2 != 0 {
        return None;
    }
    s.chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// Checks `sums` (the raw SHA256SUMS bytes) against the hex Ed25519 signature
/// `sig_text` with `key`.
fn verify_signature(key: &[u8; 32], sums: &[u8], sig_text: &str) -> Result<(), String> {
    let bad = || "badSignature".to_string();
    let sig: [u8; 64] = decode_hex(sig_text.trim()).and_then(|b| b.try_into().ok()).ok_or_else(bad)?;
    let key = VerifyingKey::from_bytes(key).map_err(|_| bad())?;
    key.verify_strict(sums, &Signature::from_bytes(&sig)).map_err(|_| bad())
}

fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    // A checksum list is a few hundred bytes; the cap only guards memory.
    agent()
        .get(url)
        .call()
        .map_err(|e| e.to_string())?
        .into_reader()
        .take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// The hash on the `<hex>  <file name>` line of `sums` for `asset_name`.
fn expected_hash(sums: &str, asset_name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset_name).then(|| hash.to_ascii_lowercase())
    })
}

/// Verifies the release signature over SHA256SUMS, then checks `sha256`
/// against the line for `asset_name`. The signature comes first: until it
/// holds, nothing in SHA256SUMS is trusted.
fn verify_checksum(checksums_url: &str, signature_url: &str, asset_name: &str, sha256: &str) -> Result<(), String> {
    let sums = fetch_bytes(checksums_url).map_err(|_| "checksumsFailed".to_string())?;
    let sig = fetch_bytes(signature_url).map_err(|_| "badSignature".to_string())?;
    verify_signature(&RELEASE_PUBLIC_KEY, &sums, &String::from_utf8_lossy(&sig))?;
    let expected = expected_hash(&String::from_utf8_lossy(&sums), asset_name).ok_or("notListed")?;
    if expected != sha256 {
        return Err("mismatch".into());
    }
    Ok(())
}

/// Downloads (unless an earlier run already has) and verifies the update
/// `update_check` found, then opens Android's installer on it.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    installer: State<'_, Installer>,
    on_progress: Channel<UpdateProgress>,
) -> Result<InstallOutcome, String> {
    if !cfg!(target_os = "android") {
        return Err("androidOnly".into());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let result = run_install(&app, &state, &installer, on_progress).await;
    state.busy.store(false, Ordering::SeqCst);
    result
}

async fn run_install(app: &AppHandle, state: &UpdaterState, installer: &Installer, on_progress: Channel<UpdateProgress>) -> Result<InstallOutcome, String> {
    let (asset_name, asset_url, checksums_url, signature_url, size, verified) = {
        let pending = lock(&state.pending);
        let pending = pending.as_ref().ok_or("noUpdate")?;
        (
            pending.asset_name.clone(),
            pending.asset_url.clone(),
            pending.checksums_url.clone(),
            pending.signature_url.clone(),
            pending.info.size,
            pending.verified.clone(),
        )
    };
    // Re-checked here, not just in update_check: this is the last gate
    // before anything is downloaded or installed.
    if ![Some(&asset_url), checksums_url.as_ref(), signature_url.as_ref()].into_iter().flatten().all(|u| is_trusted_url(u)) {
        return Err("untrusted".into());
    }
    let apk = match verified.filter(|p| p.is_file()) {
        Some(path) => path,
        None => {
            let dir = update_dir(app)?;
            let path = dir.join(&asset_name);
            let work = path.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                // Starts clean: leftovers of earlier attempts would make `create_new` fail.
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).map_err(|_| "downloadFailed".to_string())?;
                let sha256 = download(&asset_url, &work, size, &on_progress)?;
                let _ = on_progress.send(UpdateProgress::Verify);
                // No checksums, no install: skipping the check isn't a safe fallback.
                let sums = checksums_url.ok_or("noChecksums")?;
                let sig = signature_url.ok_or("badSignature")?;
                verify_checksum(&sums, &sig, &asset_name, &sha256)
            })
            .await
            .map_err(|e| e.to_string())?;
            if let Err(e) = result {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            if let Some(p) = lock(&state.pending).as_mut() {
                p.verified = Some(path.clone());
            }
            path
        }
    };
    let installer = installer.clone();
    tauri::async_runtime::spawn_blocking(move || installer.install(&apk)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{decode_hex, expected_hash, is_trusted_url, parse_version, verify_signature};
    use ed25519_dalek::{Signer, SigningKey};

    fn sign(sums: &[u8]) -> ([u8; 32], String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let sig: String = sk.sign(sums).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        (sk.verifying_key().to_bytes(), sig)
    }

    #[test]
    fn accepts_valid_signature_and_rejects_tampering() {
        let sums = b"abc  Flowcode-Android-1.0.0.apk\n";
        let (key, sig) = sign(sums);
        assert!(verify_signature(&key, sums, &format!("{sig}\n")).is_ok());
        assert!(verify_signature(&key, b"abd  Flowcode-Android-1.0.0.apk\n", &sig).is_err());
        assert!(verify_signature(&key, sums, "zz").is_err());
        assert!(verify_signature(&key, sums, &sig[..126]).is_err());
        assert_eq!(decode_hex("0aFf"), Some(vec![0x0a, 0xff]));
        assert_eq!(decode_hex("abc"), None);
    }

    #[test]
    fn only_trusts_release_download_urls() {
        assert!(is_trusted_url("https://github.com/MaxMoffa/flowcode/releases/download/v1/SHA256SUMS"));
        assert!(!is_trusted_url("https://github.com/Evil/flowcode/releases/download/v1/x"));
        assert!(!is_trusted_url("http://github.com/MaxMoffa/flowcode/releases/download/v1/x"));
        assert!(!is_trusted_url("https://github.com.evil.com/MaxMoffa/flowcode/releases/download/"));
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("v0.3.0"), Some((0, 3, 0)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v0.10.0") > parse_version("v0.9.9"));
    }

    #[test]
    fn finds_the_hash_for_the_apk() {
        let sums = "AA11  Flowcode-Setup-1.0.0.exe\nBB22 *Flowcode-Android-1.0.0.apk\n";
        assert_eq!(expected_hash(sums, "Flowcode-Android-1.0.0.apk").as_deref(), Some("bb22"));
        assert_eq!(expected_hash(sums, "other.apk"), None);
    }
}
