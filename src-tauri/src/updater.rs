//! Self-update from the public GitHub releases.
//!
//! `update_check` asks GitHub for the latest release and picks this
//! platform's installer out of its assets (the names `release.yml` gives
//! them). `update_install` downloads that installer (progress streamed over a
//! `Channel`), checks it against the release's `SHA256SUMS` when there is
//! one, and starts it in its silent `--update` mode (see the installer's
//! main.rs): it waits for this process to exit, installs over the current
//! install folder and relaunches Flowcode - no wizard. Everything open is
//! saved beforehand (see `session::session_flush_all`), so the new version
//! comes back with the same windows and tabs.

use crate::util::decode_hex;
use flowcode_shared::i18n::{is_italian, tr};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/MaxMoffa/flowcode/releases/latest";
/// GitHub's maximum page size - far more releases than the changelog tab
/// will realistically ever need.
const RELEASES_URL: &str = "https://api.github.com/repos/MaxMoffa/flowcode/releases?per_page=100";
const USER_AGENT: &str = concat!("flowcode/", env!("CARGO_PKG_VERSION"));
const CHECKSUMS_ASSET: &str = "SHA256SUMS";
const SIGNATURE_ASSET: &str = "SHA256SUMS.sig";
/// Every asset (installer, checksums, signature) must come from this
/// repository's release downloads, so a tampered API answer can't point the
/// updater at some other host.
const ASSET_URL_PREFIX: &str = "https://github.com/MaxMoffa/flowcode/releases/download/";

/// Public half of the release signing key; `SHA256SUMS.sig` must be a valid
/// Ed25519 signature over `SHA256SUMS` made with the matching private key.
/// The private key lives at `~/.flowcode-release/signing-key.pem` on the
/// owner's machine (see scripts/release-keygen.mjs). If it is lost, builds
/// with this key embedded can never again be updated to a newly signed
/// release - back it up.
const RELEASE_PUBLIC_KEY: [u8; 32] = [
    0x32, 0xc7, 0xc0, 0xd9, 0x90, 0xc8, 0xa2, 0xc5, 0x8c, 0x08, 0xda, 0xef, 0xfc, 0xa7, 0x44, 0xae,
    0x7e, 0x91, 0x79, 0x32, 0xc4, 0x4f, 0xbd, 0xd1, 0x76, 0x84, 0xe0, 0xee, 0x43, 0x1e, 0x5f, 0x28,
];

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
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

/// What the frontend shows in the "update available" dialog.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release's description (markdown), as written on GitHub.
    pub notes: String,
    pub page_url: String,
    pub size: u64,
}

/// The release `update_check` last found, with the download details the
/// frontend never gets to choose: `update_install` only ever downloads what
/// the check itself picked out of GitHub's answer.
struct PendingRelease {
    info: UpdateInfo,
    asset_name: String,
    asset_url: String,
    checksums_url: Option<String>,
    signature_url: Option<String>,
}

#[derive(Default)]
pub struct UpdaterState(Mutex<Option<PendingRelease>>, std::sync::atomic::AtomicBool);
// .1: an install is running - a second `update_install` would download into
// a second folder and start a second installer.

/// One published release, as the changelog tab lists it.
#[derive(Serialize)]
pub struct ReleaseNote {
    pub version: String,
    /// The release title set on GitHub (falls back to the tag).
    pub title: String,
    /// The release's description (markdown), as written on GitHub.
    pub notes: String,
    /// ISO 8601; empty when GitHub didn't give one.
    pub published_at: String,
    pub page_url: String,
    pub prerelease: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum UpdateProgress {
    Download { downloaded: u64, total: u64 },
    Verify,
    Install,
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

/// This platform's installer among a release's assets - matched on the file
/// names release.yml gives them.
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    assets.iter().find(|a| {
        let name = a.name.as_str();
        if !name.starts_with("Flowcode-Setup-") {
            return false;
        }
        if cfg!(target_os = "windows") {
            name.ends_with(".exe")
        } else if cfg!(target_os = "macos") {
            name.ends_with("-macos-universal.zip")
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            name.ends_with("-linux-x86_64.tar.gz")
        } else {
            false
        }
    })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
}

/// GETs one of the GitHub API URLs above and parses its JSON, with the
/// failures a user can act on spelled out.
fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let response = agent()
        .get(url)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            // Also what GitHub answers for a private repository.
            ureq::Error::Status(404, _) => {
                tr("Nessuna release pubblica trovata su GitHub (MaxMoffa/flowcode).", "No public release found on GitHub (MaxMoffa/flowcode).").to_string()
            }
            ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => {
                tr("Troppe richieste a GitHub: riprova tra qualche minuto.", "Too many requests to GitHub: try again in a few minutes.").to_string()
            }
            other => if is_italian() { format!("Impossibile contattare GitHub: {other}") } else { format!("Couldn't reach GitHub: {other}") },
        })?;
    serde_json::from_reader(response.into_reader()).map_err(|e| e.to_string())
}

/// Every published release, newest first (GitHub's own order) - drafts
/// left out. What the changelog tab shows.
#[tauri::command]
pub async fn release_notes() -> Result<Vec<ReleaseNote>, String> {
    let releases: Vec<GhRelease> = crate::blocking(|| fetch_json(RELEASES_URL)).await?;
    Ok(releases
        .into_iter()
        .filter(|r| !r.draft)
        .map(|r| {
            let version = r.tag_name.trim_start_matches('v').to_string();
            ReleaseNote {
                title: r.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| r.tag_name.clone()),
                version,
                notes: r.body.unwrap_or_default(),
                published_at: r.published_at.unwrap_or_default(),
                page_url: r.html_url,
                prerelease: r.prerelease,
            }
        })
        .collect())
}

/// `Some` when GitHub has a newer release than this build with an installer
/// for this platform, `None` when this build is up to date.
#[tauri::command]
pub async fn update_check(state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String> {
    let release: GhRelease = crate::blocking(|| fetch_json(LATEST_RELEASE_URL)).await?;

    let current = env!("CARGO_PKG_VERSION");
    let (Some(latest), Some(installed)) = (parse_version(&release.tag_name), parse_version(current)) else {
        return Err(if is_italian() { format!("Versione non riconosciuta: {}", release.tag_name) } else { format!("Unrecognized version: {}", release.tag_name) });
    };
    if release.draft || release.prerelease || latest <= installed {
        *crate::util::lock(&state.0) = None;
        return Ok(None);
    }
    let Some(asset) = pick_asset(&release.assets) else {
        return Err(tr("La nuova versione non ha un installer per questo sistema.", "The new version has no installer for this system.").to_string());
    };
    let info = UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        current_version: current.to_string(),
        notes: release.body.clone().unwrap_or_default(),
        page_url: release.html_url.clone(),
        size: asset.size,
    };
    if !is_trusted_url(&asset.browser_download_url) {
        return Err(tr("L'installer non proviene dalle release ufficiali: aggiornamento annullato.", "The installer isn't from the official releases: update cancelled.").to_string());
    }
    let find_trusted = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.clone())
            .filter(|u| is_trusted_url(u))
    };
    let checksums_url = find_trusted(CHECKSUMS_ASSET);
    let signature_url = find_trusted(SIGNATURE_ASSET);
    *crate::util::lock(&state.0) = Some(PendingRelease {
        info: info.clone(),
        asset_name: asset.name.clone(),
        asset_url: asset.browser_download_url.clone(),
        checksums_url,
        signature_url,
    });
    Ok(Some(info))
}

fn is_trusted_url(url: &str) -> bool {
    url.starts_with(ASSET_URL_PREFIX)
}

/// The folder the running Flowcode was installed into - what the installer
/// writes over. Refuses anything that doesn't look like an installer-made
/// install (a dev build under `target/`, a copy run from elsewhere): updating
/// that would drop a full install on top of it.
fn install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let (dir, marker) = {
        // .../<dir>/Flowcode.app/Contents/MacOS/flowcode
        let app = exe.ancestors().nth(3).ok_or(tr("percorso dell'app non valido", "invalid app path"))?;
        if app.file_name().and_then(|n| n.to_str()) != Some("Flowcode.app") {
            return Err(tr("Flowcode non è stato installato con l'installer: aggiornalo a mano.", "Flowcode wasn't installed with the installer: update it by hand.").to_string());
        }
        let dir = app.parent().ok_or(tr("percorso dell'app non valido", "invalid app path"))?.to_path_buf();
        (dir, app.join("Contents/Resources/config/shortcuts.json"))
    };
    #[cfg(not(target_os = "macos"))]
    let (dir, marker) = {
        let dir = exe.parent().ok_or(tr("percorso dell'app non valido", "invalid app path"))?.to_path_buf();
        let marker = dir.join("config").join("shortcuts.json");
        (dir, marker)
    };
    if cfg!(debug_assertions) || !marker.is_file() {
        return Err(tr("Flowcode non è stato installato con l'installer: aggiornalo a mano.", "Flowcode wasn't installed with the installer: update it by hand.").to_string());
    }
    Ok(dir)
}

/// A fresh, randomly named folder only this user can write to, for the
/// download and the unpacked installer. On Linux the temp dir is the shared
/// `/tmp`: a fixed name there could be pre-created by another local user, who
/// could then swap the installer between its checksum check and its launch.
/// `create_dir` (not `create_dir_all`) fails if the folder already exists.
fn create_work_dir() -> Result<PathBuf, String> {
    let temp = std::env::temp_dir();
    // Best effort: leftovers of earlier updates (the installer ran from
    // there, so they couldn't be removed at the time). Only ever succeeds on
    // folders this user owns; a younger one may belong to another running
    // Flowcode's update, so it is left alone.
    if let Ok(entries) = std::fs::read_dir(&temp) {
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > day));
            if old && name.to_str().is_some_and(|n| n.starts_with("flowcode-update-")) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let dir = temp.join(format!("flowcode-update-{}", uuid::Uuid::new_v4().simple()));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn download(
    url: &str,
    dest: &Path,
    expected_size: u64,
    on_progress: &Channel<UpdateProgress>,
) -> Result<String, String> {
    let response = agent()
        .get(url)
        .timeout(Duration::from_secs(15 * 60))
        .call()
        .map_err(|e| if is_italian() { format!("Download non riuscito: {e}") } else { format!("Download failed: {e}") })?;
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(expected_size);
    let mut reader = response.into_reader();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
    loop {
        let n = reader.read(&mut buf).map_err(|e| if is_italian() { format!("Download interrotto: {e}") } else { format!("Download interrupted: {e}") })?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        if last_report.elapsed() >= Duration::from_millis(100) {
            last_report = Instant::now();
            let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
    if total > 0 && downloaded != total {
        return Err(tr("Download incompleto: riprova.", "Incomplete download: try again.").to_string());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn bad_signature() -> String {
    tr("La firma della release manca o non è valida: aggiornamento annullato.", "The release signature is missing or invalid: update cancelled.").to_string()
}

/// Checks `sums` (the raw SHA256SUMS bytes) against the hex Ed25519 signature
/// `sig_text` with `key`.
fn verify_signature(key: &[u8; 32], sums: &[u8], sig_text: &str) -> Result<(), String> {
    let sig: [u8; 64] = decode_hex(sig_text.trim())
        .and_then(|b| b.try_into().ok())
        .ok_or_else(bad_signature)?;
    let key = VerifyingKey::from_bytes(key).map_err(|_| bad_signature())?;
    key.verify_strict(sums, &Signature::from_bytes(&sig)).map_err(|_| bad_signature())
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

/// Verifies the release signature over SHA256SUMS, then checks `sha256`
/// against the `<hex>  <file name>` line for `asset_name`. The signature
/// comes first: until it holds, nothing in SHA256SUMS is trusted.
fn verify_checksum(checksums_url: &str, signature_url: &str, asset_name: &str, sha256: &str) -> Result<(), String> {
    let sums = fetch_bytes(checksums_url)
        .map_err(|e| if is_italian() { format!("Impossibile scaricare i checksum: {e}") } else { format!("Couldn't download the checksums: {e}") })?;
    let sig = fetch_bytes(signature_url).map_err(|_| bad_signature())?;
    verify_signature(&RELEASE_PUBLIC_KEY, &sums, &String::from_utf8_lossy(&sig))?;
    let sums = String::from_utf8_lossy(&sums);
    let expected = sums
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (name == asset_name).then(|| hash.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| if is_italian() { format!("{asset_name} non è elencato nei checksum della release.") } else { format!("{asset_name} is not listed in the release checksums.") })?;
    if expected != sha256 {
        return Err(tr("Il file scaricato non corrisponde al checksum della release: aggiornamento annullato.", "The downloaded file doesn't match the release checksum: update cancelled.").to_string());
    }
    Ok(())
}

/// Turns the downloaded asset into a runnable installer binary: the `.exe`
/// itself on Windows, unpacked from its archive elsewhere.
fn prepare_installer(downloaded: &Path, work_dir: &Path) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = work_dir;
        Ok(downloaded.to_path_buf())
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let out = work_dir.join("unpacked");
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("tar")
            .arg("-xzf")
            .arg(downloaded)
            .arg("-C")
            .arg(&out)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(tr("Impossibile estrarre l'installer scaricato.", "Couldn't extract the downloaded installer.").to_string());
        }
        let bin = std::fs::read_dir(&out)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Flowcode-Setup-")))
            .ok_or(tr("Installer non trovato nell'archivio scaricato.", "Installer not found in the downloaded archive."))?;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        Ok(bin)
    }
    #[cfg(target_os = "macos")]
    {
        let out = work_dir.join("unpacked");
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("ditto")
            .args(["-x", "-k"])
            .arg(downloaded)
            .arg(&out)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(tr("Impossibile estrarre l'installer scaricato.", "Couldn't extract the downloaded installer.").to_string());
        }
        let bin = out.join("Flowcode Setup.app/Contents/MacOS/flowcode-installer");
        if !bin.is_file() {
            return Err(tr("Installer non trovato nell'archivio scaricato.", "Installer not found in the downloaded archive.").to_string());
        }
        Ok(bin)
    }
}

/// Starts the installer detached, in its silent update mode. On Windows it's
/// first tried outside this app's Job Object: a job that kills its members
/// when it closes would otherwise take the installer down with it the moment
/// Flowcode exits.
fn launch_installer(installer: &Path, install_dir: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new(installer);
    cmd.arg("--update")
        .arg(install_dir)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ()).map_err(|e| if is_italian() { format!("Impossibile avviare l'installer: {e}") } else { format!("Couldn't start the installer: {e}") })
}

/// Downloads, verifies and starts the update `update_check` found, then quits;
/// the installer takes it from there and relaunches the new version. Only
/// returns (with an error) when something failed before the hand-off.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    if state.1.swap(true, SeqCst) {
        return Err(tr("Aggiornamento già in corso.", "An update is already in progress.").to_string());
    }
    let result = run_install(&app, &state, on_progress).await;
    state.1.store(false, SeqCst);
    result
}

/// Removes the update's work dir when dropped, unless disarmed - so an early
/// error doesn't leave the downloaded installer behind in the temp folder.
struct WorkDirGuard(Option<PathBuf>);

impl Drop for WorkDirGuard {
    fn drop(&mut self) {
        if let Some(dir) = self.0.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

async fn run_install(app: &AppHandle, state: &UpdaterState, on_progress: Channel<UpdateProgress>) -> Result<(), String> {
    let (asset_name, asset_url, checksums_url, signature_url, size) = {
        let pending = crate::util::lock(&state.0);
        let pending = pending.as_ref().ok_or(tr("Nessun aggiornamento disponibile: controlla di nuovo.", "No update available: check again."))?;
        (
            pending.asset_name.clone(),
            pending.asset_url.clone(),
            pending.checksums_url.clone(),
            pending.signature_url.clone(),
            pending.info.size,
        )
    };
    // Re-checked here, not just in update_check: this is the last gate
    // before anything is downloaded or run.
    if ![Some(&asset_url), checksums_url.as_ref(), signature_url.as_ref()].into_iter().flatten().all(|u| is_trusted_url(u)) {
        return Err(tr("Indirizzo di download non attendibile: aggiornamento annullato.", "Untrusted download address: update cancelled.").to_string());
    }
    let install_dir = install_dir()?;

    let progress = on_progress.clone();
    let (installer, mut work_guard) = crate::blocking(move || {
        let work_dir = create_work_dir()?;
        let guard = WorkDirGuard(Some(work_dir.clone()));
        let downloaded = work_dir.join(&asset_name);
        let sha256 = download(&asset_url, &downloaded, size, &progress)?;
        let _ = progress.send(UpdateProgress::Verify);
        // No checksums, no install: the installer is about to run with the
        // user's rights, so skipping the check isn't a safe fallback.
        let url = checksums_url.ok_or(tr("La release non contiene SHA256SUMS: aggiornamento annullato.", "The release has no SHA256SUMS: update cancelled."))?;
        let sig_url = signature_url.ok_or_else(bad_signature)?;
        verify_checksum(&url, &sig_url, &asset_name, &sha256)?;
        let installer = prepare_installer(&downloaded, &work_dir)?;
        Ok((installer, guard))
    })
    .await?;

    let _ = on_progress.send(UpdateProgress::Install);
    // Every window writes its tabs out first - the relaunched version
    // restores them (see session.rs).
    crate::session::flush_all(app).await;
    launch_installer(&installer, &install_dir)?;
    // The installer runs from the work dir: it has to stay.
    work_guard.0 = None;
    app.state::<crate::session::SessionStore>().set_quitting();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_hex, is_trusted_url, parse_version, verify_signature};
    use ed25519_dalek::{Signer, SigningKey};

    fn sign(sums: &[u8]) -> ([u8; 32], String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let sig: String = sk.sign(sums).to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        (sk.verifying_key().to_bytes(), sig)
    }

    #[test]
    fn accepts_valid_signature() {
        let sums = b"abc  Flowcode-Setup-1.0.0.exe\n";
        let (key, sig) = sign(sums);
        assert!(verify_signature(&key, sums, &format!("{sig}\n")).is_ok());
    }

    #[test]
    fn rejects_tampered_sums() {
        let (key, sig) = sign(b"abc  Flowcode-Setup-1.0.0.exe\n");
        assert!(verify_signature(&key, b"abd  Flowcode-Setup-1.0.0.exe\n", &sig).is_err());
    }

    #[test]
    fn rejects_bad_hex_and_length() {
        let (key, sig) = sign(b"x");
        assert!(verify_signature(&key, b"x", "zz").is_err());
        assert!(verify_signature(&key, b"x", &sig[..126]).is_err());
        assert!(verify_signature(&key, b"x", "").is_err());
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
        assert_eq!(parse_version("v1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v0.10.0") > parse_version("v0.9.9"));
    }
}
