//! The endpoint's persisted identity: the node key (sealed with DPAPI on
//! Windows) and the lock that keeps two instances off the same endpoint.

use std::path::Path;

use flowcode_shared::i18n::tr;
use iroh::SecretKey;

use super::hex::to_hex;
use crate::util::decode_hex;

/// The endpoint's secret key, persisted so the node id (and with it every
/// paired phone's idea of this desktop) survives restarts. 64 hex chars.
///
/// On Windows the file holds the key sealed with DPAPI (tied to the user's
/// login, so a copy of the file is useless elsewhere); an older plain-hex
/// file is converted on first read.
pub(super) fn load_or_create_key(path: &Path) -> Result<SecretKey, String> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let text = text.trim();
        let (bytes, sealed) = match text.strip_prefix(SEALED_PREFIX) {
            Some(blob) => (decode_hex(blob).and_then(|b| unseal(&b)).and_then(|k| decode_key(&String::from_utf8(k).ok()?)), true),
            None => (decode_key(text), false),
        };
        if let Some(bytes) = bytes {
            if !sealed && SEALING {
                if let Err(e) = write_key(path, &bytes) {
                    eprintln!("remote: cannot protect the node key: {e}");
                }
            }
            return Ok(SecretKey::from_bytes(&bytes));
        }
        // An unreadable key is replaced: paired phones then fail to auth and
        // must be paired again, which is better than not starting at all.
        eprintln!("remote: {} is corrupt, generating a new node key", path.display());
    }
    let key = SecretKey::generate();
    write_key(path, &key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    decode_hex(hex.trim()).and_then(|bytes| bytes.try_into().ok())
}

/// Marks a key file whose hex is a DPAPI blob rather than the key itself.
const SEALED_PREFIX: &str = "dpapi1:";

/// Whether this platform seals the key file (see `seal`).
const SEALING: bool = cfg!(windows);

fn write_key(path: &Path, key: &[u8; 32]) -> std::io::Result<()> {
    let hex = to_hex(key);
    let content = match seal(hex.as_bytes()) {
        Some(blob) => format!("{SEALED_PREFIX}{}", to_hex(&blob)),
        None => hex,
    };
    write_private(path, content.as_bytes())
}

/// Encrypts `plain` for the current Windows user (DPAPI). `None` where there
/// is no such facility - or if it failed, in which case the key is kept
/// readable the way it always was rather than lost.
#[cfg(windows)]
fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(not(windows))]
fn seal(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn unseal(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi(blob, false)
}

#[cfg(not(windows))]
fn unseal(_blob: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let blob_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut blob_out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: both blobs point to live memory for the call; on success the
    // output buffer is ours (allocated by the system) and freed below.
    let ok = unsafe {
        if protect {
            CryptProtectData(&blob_in, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut blob_out)
        } else {
            CryptUnprotectData(&blob_in, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut blob_out)
        }
    };
    if ok == 0 || blob_out.pbData.is_null() {
        return None;
    }
    // SAFETY: the call succeeded, so `pbData` holds `cbData` bytes.
    let out = unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
    unsafe { LocalFree(blob_out.pbData as _) };
    Some(out)
}

/// An exclusive lock on a file next to the node key, held for as long as the
/// endpoint runs: two Flowcode instances sharing a config dir would otherwise
/// fight over the same node id (each kicking the other's phone). Dropping the
/// returned file releases it.
pub(super) fn acquire_instance_lock(key_path: &Path) -> Result<std::fs::File, String> {
    let busy = || {
        tr(
            "Accesso remoto già attivo in un'altra finestra/istanza di Flowcode",
            "Remote access is already active in another Flowcode window/instance",
        )
        .to_string()
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(key_path.with_extension("lock"))
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(busy()),
        Err(std::fs::TryLockError::Error(e)) => Err(e.to_string()),
    }
}

/// Writes through a temp file renamed into place, readable by the owner only
/// on Unix (the file is the node's identity).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::scratch;
    use super::*;

    #[test]
    fn node_key_survives_a_reload() {
        let dir = std::env::temp_dir().join(format!("flowcode-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote-node.key");
        let first = load_or_create_key(&path).unwrap();
        let second = load_or_create_key(&path).unwrap();
        assert_eq!(first.public(), second.public());
        std::fs::write(&path, "garbage").unwrap();
        assert_ne!(load_or_create_key(&path).unwrap().public(), first.public());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_instance_cannot_take_the_endpoint() {
        let dir = scratch("lock");
        let key = dir.join("remote-node.key");
        let first = acquire_instance_lock(&key).unwrap();
        assert!(acquire_instance_lock(&key).is_err());
        drop(first);
        assert!(acquire_instance_lock(&key).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn node_key_is_sealed_on_windows_and_a_plain_one_migrates() {
        let dir = scratch("seal");
        let path = dir.join("remote-node.key");
        let key = load_or_create_key(&path).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with(SEALED_PREFIX));
        assert!(!on_disk.contains(&to_hex(&key.to_bytes())));
        assert_eq!(load_or_create_key(&path).unwrap().public(), key.public());

        // A key written by an earlier version: same identity, now sealed.
        std::fs::write(&path, to_hex(&key.to_bytes())).unwrap();
        assert_eq!(load_or_create_key(&path).unwrap().public(), key.public());
        assert!(std::fs::read_to_string(&path).unwrap().starts_with(SEALED_PREFIX));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
