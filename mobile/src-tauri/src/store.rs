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

/// Turns secrets into what lands on disk. The phone implements it with the
/// Android Keystore; keeping it a trait leaves this module free of Tauri.
pub trait Codec {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
    /// Whether `seal` really encrypts. Gates the plaintext-to-sealed migration.
    fn seals(&self) -> bool;
}

/// No encryption: desktop dev builds and the smoke example.
pub struct Plain;

impl Codec for Plain {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
    fn seals(&self) -> bool {
        false
    }
}

/// Marks a sealed file, so older plaintext files can still be told apart.
const MAGIC: &[u8] = b"FCS1";

enum Read {
    Missing,
    Failed(String),
    /// `legacy`: the file was plaintext and should be rewritten sealed.
    Found { plain: Vec<u8>, legacy: bool },
}

fn read_secret(path: &Path, codec: &dyn Codec) -> Read {
    let Ok(bytes) = std::fs::read(path) else { return Read::Missing };
    match bytes.strip_prefix(MAGIC) {
        Some(sealed) if codec.seals() => match codec.open(sealed) {
            Ok(plain) => Read::Found { plain, legacy: false },
            Err(e) => Read::Failed(e),
        },
        // Handing sealed bytes to a pass-through codec would yield garbage.
        Some(_) => Read::Failed("file is sealed but no secure store is available".into()),
        None => Read::Found { plain: bytes, legacy: true },
    }
}

fn write_secret(path: &Path, plain: &[u8], codec: &dyn Codec) -> Result<(), String> {
    if !codec.seals() {
        return write_private(path, plain).map_err(|e| e.to_string());
    }
    let mut out = MAGIC.to_vec();
    out.extend(codec.seal(plain)?);
    write_private(path, &out).map_err(|e| e.to_string())
}

/// Rewrites a plaintext file sealed. Best effort: the secret was read fine, so
/// a failure here only means it stays plaintext until the next load.
fn migrate(path: &Path, plain: &[u8], legacy: bool, codec: &dyn Codec) {
    if legacy && codec.seals() {
        if let Err(e) = write_secret(path, plain, codec) {
            eprintln!("remote: cannot seal {}: {e}", path.display());
        }
    }
}

/// The phone's secret key as 64 hex chars. It is the device's identity on the
/// desktop, so it must outlive reinstalls of the UI: a new key means pairing
/// again.
pub fn load_or_create_key(path: &Path, codec: &dyn Codec) -> Result<SecretKey, String> {
    match read_secret(path, codec) {
        Read::Found { plain, legacy } => {
            if let Some(bytes) = std::str::from_utf8(&plain).ok().and_then(|t| decode_key(t.trim())) {
                migrate(path, &plain, legacy, codec);
                return Ok(SecretKey::from_bytes(&bytes));
            }
            // Unreadable: start over rather than refusing to run. The desktop then
            // sees a new device and the user pairs again.
            eprintln!("remote: {} is corrupt, generating a new key", path.display());
        }
        // E.g. the Keystore key was lost in a restore; same outcome as corrupt.
        Read::Failed(e) => eprintln!("remote: cannot open {} ({e}), generating a new key", path.display()),
        Read::Missing => {}
    }
    let key = SecretKey::generate();
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    write_secret(path, hex.as_bytes(), codec).map_err(|e| format!("cannot save the device key: {e}"))?;
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

pub fn load_pairing(path: &Path, codec: &dyn Codec) -> Option<Pairing> {
    match read_secret(path, codec) {
        Read::Found { plain, legacy } => {
            let pairing = serde_json::from_slice(&plain).ok()?;
            migrate(path, &plain, legacy, codec);
            Some(pairing)
        }
        // Unreadable means unpaired: the user pairs again.
        Read::Failed(e) => {
            eprintln!("remote: cannot open {} ({e}), treating as unpaired", path.display());
            None
        }
        Read::Missing => None,
    }
}

pub fn save_pairing(path: &Path, pairing: &Pairing, codec: &dyn Codec) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(pairing).map_err(|e| e.to_string())?;
    write_secret(path, &bytes, codec).map_err(|e| format!("cannot save the pairing: {e}"))
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

    struct Xor;
    impl Codec for Xor {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            Ok(plain.iter().map(|b| b ^ 0x5a).collect())
        }
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            Ok(sealed.iter().map(|b| b ^ 0x5a).collect())
        }
        fn seals(&self) -> bool {
            true
        }
    }

    struct Broken;
    impl Codec for Broken {
        fn seal(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("no key".into())
        }
        fn open(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("no key".into())
        }
        fn seals(&self) -> bool {
            true
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("fcm-test-{}-{name}", std::process::id()))
    }

    fn sample() -> Pairing {
        Pairing { node: "n".into(), token: "secret-token".into(), host_name: "h".into(), device_name: "d".into() }
    }

    #[test]
    fn key_is_stable_across_loads() {
        let dir = temp("stable");
        let path = dir.join("key");
        let a = load_or_create_key(&path, &Plain).unwrap();
        let b = load_or_create_key(&path, &Plain).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sealed_round_trip() {
        let dir = temp("round");
        let (key_path, pair_path) = (dir.join("key"), dir.join("pairing"));
        let a = load_or_create_key(&key_path, &Xor).unwrap();
        assert_eq!(a.to_bytes(), load_or_create_key(&key_path, &Xor).unwrap().to_bytes());
        save_pairing(&pair_path, &sample(), &Xor).unwrap();
        let raw = std::fs::read(&pair_path).unwrap();
        assert!(raw.starts_with(MAGIC));
        assert!(!String::from_utf8_lossy(&raw).contains("secret-token"));
        assert_eq!(load_pairing(&pair_path, &Xor).unwrap().token, "secret-token");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_plaintext_is_migrated() {
        let dir = temp("legacy");
        let (key_path, pair_path) = (dir.join("key"), dir.join("pairing"));
        save_pairing(&pair_path, &sample(), &Plain).unwrap();
        let key = load_or_create_key(&key_path, &Plain).unwrap();

        assert_eq!(load_pairing(&pair_path, &Xor).unwrap().token, "secret-token");
        assert!(std::fs::read(&pair_path).unwrap().starts_with(MAGIC));
        assert_eq!(load_or_create_key(&key_path, &Xor).unwrap().to_bytes(), key.to_bytes());
        assert!(std::fs::read(&key_path).unwrap().starts_with(MAGIC));
        // Still readable after the rewrite.
        assert!(load_pairing(&pair_path, &Xor).is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_open_means_unpaired_and_new_key() {
        let dir = temp("broken");
        let (key_path, pair_path) = (dir.join("key"), dir.join("pairing"));
        save_pairing(&pair_path, &sample(), &Xor).unwrap();
        let key = load_or_create_key(&key_path, &Xor).unwrap();
        assert!(load_pairing(&pair_path, &Broken).is_none());
        // Regeneration needs a working sealer to save the new key.
        assert!(load_or_create_key(&key_path, &Broken).is_err());
        assert_eq!(load_or_create_key(&key_path, &Xor).unwrap().to_bytes(), key.to_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }
}
