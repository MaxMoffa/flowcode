//! What the phone keeps on disk: its iroh identity and, once paired, how to
//! reach and authenticate to the desktop. Free of Tauri so the smoke example
//! can reuse the key handling.

use iroh::SecretKey;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Everything needed to reconnect without the QR.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// The desktop's `EndpointTicket` string. Kept (not just the node id) so a
    /// reconnect works even when address lookup is unreachable.
    pub node: String,
    pub token: String,
    pub host_name: String,
    pub device_name: String,
}

/// The phone's secret key as 64 hex chars. It is the device's identity on the
/// desktop, so it must outlive reinstalls of the UI: a new key means pairing
/// again.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey, String> {
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Some(bytes) = decode_key(text.trim()) {
            return Ok(SecretKey::from_bytes(&bytes));
        }
        // Unreadable: start over rather than refusing to run. The desktop then
        // sees a new device and the user pairs again.
        eprintln!("remote: {} is corrupt, generating a new key", path.display());
    }
    let key = SecretKey::generate();
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    write_private(path, hex.as_bytes()).map_err(|e| format!("cannot save the device key: {e}"))?;
    Ok(key)
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn load_pairing(path: &Path) -> Option<Pairing> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn save_pairing(path: &Path, pairing: &Pairing) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(pairing).map_err(|e| e.to_string())?;
    write_private(path, &bytes).map_err(|e| format!("cannot save the pairing: {e}"))
}

pub fn forget_pairing(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Temp file + rename so a crash never leaves half a file; owner-only on Unix
/// because both files are credentials.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    let result = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_across_loads() {
        let dir = std::env::temp_dir().join(format!("fcm-test-{}", std::process::id()));
        let path = dir.join("key");
        let a = load_or_create_key(&path).unwrap();
        let b = load_or_create_key(&path).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }
}
