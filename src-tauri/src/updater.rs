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

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/MaxMoffa/flowcode/releases/latest";
const USER_AGENT: &str = concat!("flowcode/", env!("CARGO_PKG_VERSION"));
const CHECKSUMS_ASSET: &str = "SHA256SUMS";

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
}

#[derive(Default)]
pub struct UpdaterState(Mutex<Option<PendingRelease>>);

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

/// `Some` when GitHub has a newer release than this build with an installer
/// for this platform, `None` when this build is up to date.
#[tauri::command]
pub async fn update_check(state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String> {
    let release = crate::blocking(|| {
        let response = agent()
            .get(LATEST_RELEASE_URL)
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| match e {
                // Also what GitHub answers for a private repository.
                ureq::Error::Status(404, _) => {
                    "Nessuna release pubblica trovata su GitHub (MaxMoffa/flowcode).".to_string()
                }
                ureq::Error::Status(403, _) | ureq::Error::Status(429, _) => {
                    "Troppe richieste a GitHub: riprova tra qualche minuto.".to_string()
                }
                other => format!("Impossibile contattare GitHub: {other}"),
            })?;
        serde_json::from_reader::<_, GhRelease>(response.into_reader()).map_err(|e| e.to_string())
    })
    .await?;

    let current = env!("CARGO_PKG_VERSION");
    let (Some(latest), Some(installed)) = (parse_version(&release.tag_name), parse_version(current)) else {
        return Err(format!("Versione non riconosciuta: {}", release.tag_name));
    };
    if release.draft || release.prerelease || latest <= installed {
        *state.0.lock().unwrap() = None;
        return Ok(None);
    }
    let Some(asset) = pick_asset(&release.assets) else {
        return Err("La nuova versione non ha un installer per questo sistema.".to_string());
    };
    let info = UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        current_version: current.to_string(),
        notes: release.body.clone().unwrap_or_default(),
        page_url: release.html_url.clone(),
        size: asset.size,
    };
    let checksums_url = release
        .assets
        .iter()
        .find(|a| a.name == CHECKSUMS_ASSET)
        .map(|a| a.browser_download_url.clone());
    *state.0.lock().unwrap() = Some(PendingRelease {
        info: info.clone(),
        asset_name: asset.name.clone(),
        asset_url: asset.browser_download_url.clone(),
        checksums_url,
    });
    Ok(Some(info))
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
        let app = exe.ancestors().nth(3).ok_or("percorso dell'app non valido")?;
        if app.file_name().and_then(|n| n.to_str()) != Some("Flowcode.app") {
            return Err("Flowcode non è stato installato con l'installer: aggiornalo a mano.".to_string());
        }
        let dir = app.parent().ok_or("percorso dell'app non valido")?.to_path_buf();
        (dir, app.join("Contents/Resources/config/shortcuts.json"))
    };
    #[cfg(not(target_os = "macos"))]
    let (dir, marker) = {
        let dir = exe.parent().ok_or("percorso dell'app non valido")?.to_path_buf();
        let marker = dir.join("config").join("shortcuts.json");
        (dir, marker)
    };
    if cfg!(debug_assertions) || !marker.is_file() {
        return Err("Flowcode non è stato installato con l'installer: aggiornalo a mano.".to_string());
    }
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
        .map_err(|e| format!("Download non riuscito: {e}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(expected_size);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    let _ = on_progress.send(UpdateProgress::Download { downloaded, total });
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrotto: {e}"))?;
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
        return Err("Download incompleto: riprova.".to_string());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Checks `sha256` against the `<hex>  <file name>` line for `asset_name` in
/// the release's SHA256SUMS.
fn verify_checksum(checksums_url: &str, asset_name: &str, sha256: &str) -> Result<(), String> {
    let sums = agent()
        .get(checksums_url)
        .call()
        .map_err(|e| format!("Impossibile scaricare i checksum: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let expected = sums
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (name == asset_name).then(|| hash.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| format!("{asset_name} non è elencato nei checksum della release."))?;
    if expected != sha256 {
        return Err("Il file scaricato non corrisponde al checksum della release: aggiornamento annullato.".to_string());
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
            return Err("Impossibile estrarre l'installer scaricato.".to_string());
        }
        let bin = std::fs::read_dir(&out)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Flowcode-Setup-")))
            .ok_or("Installer non trovato nell'archivio scaricato.")?;
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
            return Err("Impossibile estrarre l'installer scaricato.".to_string());
        }
        let bin = out.join("Flowcode Setup.app/Contents/MacOS/flowcode-installer");
        if !bin.is_file() {
            return Err("Installer non trovato nell'archivio scaricato.".to_string());
        }
        Ok(bin)
    }
}

/// Starts the installer detached, in its silent update mode. On Windows it's
/// first tried outside this app's Job Object (see `job_breakaway_allowed` in
/// plugins.rs): a job that kills its members when it closes would otherwise
/// take the installer down with it the moment Flowcode exits.
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
    cmd.spawn().map(|_| ()).map_err(|e| format!("Impossibile avviare l'installer: {e}"))
}

/// Downloads, verifies and starts the update `update_check` found, then quits
/// - the installer takes it from there and relaunches the new version. Only
/// returns (with an error) when something failed before the hand-off.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let (asset_name, asset_url, checksums_url, size) = {
        let pending = state.0.lock().unwrap();
        let pending = pending.as_ref().ok_or("Nessun aggiornamento disponibile: controlla di nuovo.")?;
        (
            pending.asset_name.clone(),
            pending.asset_url.clone(),
            pending.checksums_url.clone(),
            pending.info.size,
        )
    };
    let install_dir = install_dir()?;

    let progress = on_progress.clone();
    let installer = crate::blocking(move || {
        let work_dir = std::env::temp_dir().join("flowcode-update");
        let _ = std::fs::remove_dir_all(&work_dir);
        std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
        let downloaded = work_dir.join(&asset_name);
        let sha256 = download(&asset_url, &downloaded, size, &progress)?;
        let _ = progress.send(UpdateProgress::Verify);
        if let Some(url) = checksums_url {
            verify_checksum(&url, &asset_name, &sha256)?;
        }
        prepare_installer(&downloaded, &work_dir)
    })
    .await?;

    let _ = on_progress.send(UpdateProgress::Install);
    // Every window writes its tabs out first - the relaunched version
    // restores them (see session.rs).
    crate::session::flush_all(&app).await;
    launch_installer(&installer, &install_dir)?;
    app.state::<crate::session::SessionStore>().set_quitting();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("v0.3.0"), Some((0, 3, 0)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("v1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v0.10.0") > parse_version("v0.9.9"));
    }
}
