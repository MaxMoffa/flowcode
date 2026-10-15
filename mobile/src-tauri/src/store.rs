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
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, OpenError>;
    /// Whether `seal` really encrypts. Gates the plaintext-to-sealed migration.
    fn seals(&self) -> bool;
}

/// Why `Codec::open` failed. The difference matters: only a `Lost` secret may
/// be replaced by a new one; after a `Transient` failure (Keystore busy,
/// device locked, a hiccup) the sealed file is probably still good and must
/// not be overwritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// The key is gone or the data cannot be decrypted, ever.
    Lost(String),
    /// Might work if tried again later.
    Transient(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Lost(m) | OpenError::Transient(m) => f.write_str(m),
        }
    }
}

/// No encryption: desktop dev builds and the smoke example.
pub struct Plain;

impl Codec for Plain {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
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
    /// Definitively unreadable (see [`OpenError::Lost`]).
    Lost(String),
    /// Unreadable for now; the file must be left alone.
    Failed(String),
    /// `legacy`: the file was plaintext and should be rewritten sealed.
    Found { plain: Vec<u8>, legacy: bool },
}

fn read_secret(path: &Path, codec: &dyn Codec) -> Read {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Missing,
        // Any other I/O error says nothing about the content.
        Err(e) => return Read::Failed(e.to_string()),
    };
    match bytes.strip_prefix(MAGIC) {
        Some(sealed) if codec.seals() => match codec.open(sealed) {
            Ok(plain) => Read::Found { plain, legacy: false },
            Err(OpenError::Lost(e)) => Read::Lost(e),
            Err(OpenError::Transient(e)) => Read::Failed(e),
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
/// again. A new key is generated only when the old one is definitively gone
/// (missing file, corrupt content, lost Keystore key); a transient Keystore
/// error is returned so the caller retries instead of destroying the pairing.
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
        Read::Lost(e) => eprintln!("remote: cannot open {} ({e}), generating a new key", path.display()),
        Read::Failed(e) => return Err(format!("cannot read the device key (will retry): {e}")),
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

/// What `load_pairing` found. `Unreadable` is not `Missing`: the file is still
/// there and probably fine (Keystore busy, device locked), so the phone is
/// still paired, just offline for now.
pub enum PairingLoad {
    Missing,
    /// Opened fine but is not a pairing (corrupt or from an incompatible
    /// version): counts as unpaired, the user pairs again.
    Corrupt(String),
    /// Unreadable for now (transient); the file was left alone.
    Unreadable(String),
    Found(Pairing),
}

impl PairingLoad {
    /// Whether the phone counts as paired: a pairing exists, readable or not.
    pub fn is_paired(&self) -> bool {
        !matches!(self, PairingLoad::Missing | PairingLoad::Corrupt(_))
    }
}

pub fn load_pairing(path: &Path, codec: &dyn Codec) -> PairingLoad {
    match read_secret(path, codec) {
        Read::Found { plain, legacy } => match serde_json::from_slice(&plain) {
            Ok(pairing) => {
                migrate(path, &plain, legacy, codec);
                PairingLoad::Found(pairing)
            }
            Err(e) => {
                eprintln!("remote: {} is not a valid pairing ({e}), treating as unpaired", path.display());
                PairingLoad::Corrupt(e.to_string())
            }
        },
        // Definitively unreadable means unpaired: the user pairs again.
        Read::Lost(e) => {
            eprintln!("remote: cannot open {} ({e}), treating as unpaired", path.display());
            PairingLoad::Missing
        }
        Read::Failed(e) => {
            eprintln!("remote: cannot read {} ({e}), will retry", path.display());
            PairingLoad::Unreadable(e)
        }
        Read::Missing => PairingLoad::Missing,
    }
}

pub fn save_pairing(path: &Path, pairing: &Pairing, codec: &dyn Codec) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(pairing).map_err(|e| e.to_string())?;
    write_secret(path, &bytes, codec).map_err(|e| format!("cannot save the pairing: {e}"))
}

pub fn forget_pairing(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// The other desktops this phone is paired with, besides the active one in
/// `pairing.json`. Sealed like it.
pub fn load_others(path: &Path, codec: &dyn Codec) -> Result<Vec<Pairing>, String> {
    match read_secret(path, codec) {
        Read::Found { plain, legacy } => match serde_json::from_slice(&plain) {
            Ok(list) => {
                migrate(path, &plain, legacy, codec);
                Ok(list)
            }
            Err(e) => {
                // Moved aside: the next `save_others` would overwrite it and lose every saved computer.
                let aside = path.with_extension("json.corrupt");
                eprintln!("remote: {} is not a valid list ({e}), moved to {}", path.display(), aside.display());
                let _ = std::fs::remove_file(&aside);
                let _ = std::fs::rename(path, &aside);
                Ok(Vec::new())
            }
        },
        Read::Missing => Ok(Vec::new()),
        Read::Lost(e) => {
            eprintln!("remote: cannot open {} ({e}), ignoring it", path.display());
            Ok(Vec::new())
        }
        // Left alone: writing now would drop the computers it holds.
        Read::Failed(e) => Err(format!("cannot read the saved computers (will retry): {e}")),
    }
}

pub fn save_others(path: &Path, list: &[Pairing], codec: &dyn Codec) -> Result<(), String> {
    if list.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    write_secret(path, &bytes, codec).map_err(|e| format!("cannot save the computers: {e}"))
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
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
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
        fn open(&self, _: &[u8]) -> Result<Vec<u8>, OpenError> {
            Err(OpenError::Lost("no key".into()))
        }
        fn seals(&self) -> bool {
            true
        }
    }

    /// Fails like a Keystore hiccup: the data is fine, the call is not.
    struct Flaky;
    impl Codec for Flaky {
        fn seal(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("busy".into())
        }
        fn open(&self, _: &[u8]) -> Result<Vec<u8>, OpenError> {
            Err(OpenError::Transient("busy".into()))
        }
        fn seals(&self) -> bool {
            true
        }
    }

    fn found(load: PairingLoad) -> Pairing {
        match load {
            PairingLoad::Found(p) => p,
            _ => panic!("expected a pairing"),
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("fcm-test-{}-{name}", std::process::id()))
    }

    fn sample() -> Pairing {
        Pairing { node: "n".into(), token: "secret-token".into(), host_name: "h".into(), device_name: "d".into() }
    }

    #[test]
    fn others_round_trip_and_empty_removes_file() {
        let path = temp("others.json");
        assert!(load_others(&path, &Xor).unwrap().is_empty());
        save_others(&path, &[sample()], &Xor).unwrap();
        assert_eq!(load_others(&path, &Xor).unwrap()[0].token, "secret-token");
        save_others(&path, &[], &Xor).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_others_is_moved_aside() {
        let path = temp("corrupt-others.json");
        let aside = path.with_extension("json.corrupt");
        write_secret(&path, b"not json", &Xor).unwrap();
        assert!(load_others(&path, &Xor).unwrap().is_empty());
        assert!(!path.exists());
        assert!(aside.exists());
        let _ = std::fs::remove_file(&aside);
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
        assert_eq!(found(load_pairing(&pair_path, &Xor)).token, "secret-token");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_plaintext_is_migrated() {
        let dir = temp("legacy");
        let (key_path, pair_path) = (dir.join("key"), dir.join("pairing"));
        save_pairing(&pair_path, &sample(), &Plain).unwrap();
        let key = load_or_create_key(&key_path, &Plain).unwrap();

        assert_eq!(found(load_pairing(&pair_path, &Xor)).token, "secret-token");
        assert!(std::fs::read(&pair_path).unwrap().starts_with(MAGIC));
        assert_eq!(load_or_create_key(&key_path, &Xor).unwrap().to_bytes(), key.to_bytes());
        assert!(std::fs::read(&key_path).unwrap().starts_with(MAGIC));
        // Still readable after the rewrite.
        assert!(matches!(load_pairing(&pair_path, &Xor), PairingLoad::Found(_)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_open_means_unpaired_and_new_key() {
        let dir = temp("broken");
        let (key_path, pair_path) = (dir.join("key"), dir.join("pairing"));
        save_pairing(&pair_path, &sample(), &Xor).unwrap();
        let key = load_or_create_key(&key_path, &Xor).unwrap();
        assert!(matches!(load_pairing(&pair_path, &Broken), PairingLoad::Missing));
        // Regeneration needs a working sealer to save the new key.
        assert!(load_or_create_key(&key_path, &Broken).is_err());
        assert_eq!(load_or_create_key(&key_path, &Xor).unwrap().to_bytes(), key.to_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pairing_load_has_three_states() {
        let dir = temp("states");
        let path = dir.join("pairing");
        assert!(matches!(load_pairing(&path, &Xor), PairingLoad::Missing));
        save_pairing(&path, &sample(), &Xor).unwrap();
        assert!(matches!(load_pairing(&path, &Xor), PairingLoad::Found(_)));
        // A Keystore hiccup is not "unpaired", and the file survives it.
        let before = std::fs::read(&path).unwrap();
        let load = load_pairing(&path, &Flaky);
        assert!(matches!(load, PairingLoad::Unreadable(_)));
        assert!(load.is_paired());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!PairingLoad::Missing.is_paired());
        // Readable but not a pairing: unpaired, and told apart from "no file".
        write_secret(&path, b"{not json", &Xor).unwrap();
        let load = load_pairing(&path, &Xor);
        assert!(matches!(load, PairingLoad::Corrupt(_)));
        assert!(!load.is_paired());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transient_open_error_keeps_the_key() {
        let dir = temp("flaky");
        let key_path = dir.join("key");
        let key = load_or_create_key(&key_path, &Xor).unwrap();
        let before = std::fs::read(&key_path).unwrap();
        assert!(load_or_create_key(&key_path, &Flaky).is_err());
        // Neither replaced nor rewritten.
        assert_eq!(std::fs::read(&key_path).unwrap(), before);
        assert_eq!(load_or_create_key(&key_path, &Xor).unwrap().to_bytes(), key.to_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }
}
