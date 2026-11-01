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
    load_or_create_key_with(path, SEALING, &seal, &unseal)
}

/// Keep the key lifecycle testable without an interactive Windows profile.
/// Failure to read or decrypt an existing identity is not proof of corruption:
/// leave it untouched so a later attempt can recover the same pairing.
fn load_or_create_key_with(
    path: &Path,
    sealing: bool,
    protect: &dyn Fn(&[u8]) -> Option<Vec<u8>>,
    open: &dyn Fn(&[u8]) -> Option<Vec<u8>>,
) -> Result<SecretKey, String> {
    let stored = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("cannot read the node key (will retry): {e}")),
    };
    if let Some(stored) = stored {
        let text = std::str::from_utf8(&stored).ok().map(str::trim);
        let (bytes, sealed) = match text.and_then(|t| t.strip_prefix(SEALED_PREFIX)) {
            Some(blob) => {
                if !sealing {
                    return Err("cannot open the node key: no secure store is available".into());
                }
                let bytes = match decode_hex(blob).filter(|b| !b.is_empty()) {
                    Some(blob) => {
                        let plain = open(&blob).ok_or("cannot open the node key (will retry)")?;
                        std::str::from_utf8(&plain).ok().and_then(decode_key)
                    }
                    // Invalid hex is corrupt content, not a DPAPI failure.
                    None => None,
                };
                (bytes, true)
            }
            None => (text.and_then(decode_key), false),
        };
        if let Some(bytes) = bytes {
            if !sealed && sealing {
                // An unsuccessful migration must neither overwrite the old
                // identity nor let remote access run with plaintext secrets.
                write_key(path, &bytes, sealing, protect)?;
            }
            return Ok(SecretKey::from_bytes(&bytes));
        }
        // A decoded value with an invalid shape is definitively corrupt.
        eprintln!("remote: {} is corrupt, generating a new node key", path.display());
    }
    let key = SecretKey::generate();
    write_key(path, &key.to_bytes(), sealing, protect)?;
    Ok(key)
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    decode_hex(hex.trim()).and_then(|bytes| bytes.try_into().ok())
}

/// Marks a key file whose hex is a DPAPI blob rather than the key itself.
const SEALED_PREFIX: &str = "dpapi1:";

/// Whether this platform seals the key file (see `seal`).
const SEALING: bool = cfg!(windows);

fn write_key(path: &Path, key: &[u8; 32], sealing: bool, protect: &dyn Fn(&[u8]) -> Option<Vec<u8>>) -> Result<(), String> {
    let hex = to_hex(key);
    let content = if sealing {
        let blob = protect(hex.as_bytes()).filter(|b| !b.is_empty()).ok_or("cannot protect the node key (will retry)")?;
        format!("{SEALED_PREFIX}{}", to_hex(&blob))
    } else {
        hex
    };
    write_private(path, content.as_bytes()).map_err(|e| format!("cannot save the node key: {e}"))
}

/// Encrypts `plain` for the current Windows user (DPAPI). `None` where there
/// is no such facility or if it failed. Callers that require protection must
/// return an error rather than writing plaintext.
#[cfg(windows)]
pub(crate) fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(not(windows))]
pub(crate) fn seal(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
pub(crate) fn unseal(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi(blob, false)
}

#[cfg(not(windows))]
pub(crate) fn unseal(_blob: &[u8]) -> Option<Vec<u8>> {
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

    fn protect_for_test(plain: &[u8]) -> Option<Vec<u8>> {
        Some(plain.iter().map(|b| b ^ 0xa5).collect())
    }

    fn load_for_test(path: &Path) -> Result<SecretKey, String> {
        load_or_create_key_with(path, true, &protect_for_test, &protect_for_test)
    }

    #[test]
    fn node_key_survives_a_reload() {
        let dir = scratch("key");
        let path = dir.join("remote-node.key");
        let first = load_for_test(&path).unwrap();
        let second = load_for_test(&path).unwrap();
        assert_eq!(first.public(), second.public());
        std::fs::write(&path, "garbage").unwrap();
        assert_ne!(load_for_test(&path).unwrap().public(), first.public());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sealed_keys_and_plaintext_migration_keep_the_same_identity() {
        let dir = scratch("key-migration");
        let path = dir.join("remote-node.key");
        let key = load_for_test(&path).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with(SEALED_PREFIX));
        assert!(!on_disk.contains(&to_hex(&key.to_bytes())));
        assert_eq!(load_for_test(&path).unwrap().public(), key.public());
        std::fs::write(&path, to_hex(&key.to_bytes())).unwrap();
        assert_eq!(load_for_test(&path).unwrap().public(), key.public());
        assert!(std::fs::read_to_string(&path).unwrap().starts_with(SEALED_PREFIX));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn protection_failure_never_writes_plaintext_or_replaces_a_legacy_key() {
        let dir = scratch("key-protect-failure");
        let path = dir.join("remote-node.key");
        assert!(load_or_create_key_with(&path, true, &|_| None, &protect_for_test).is_err());
        assert!(!path.exists());
        let old = "42".repeat(32);
        std::fs::write(&path, &old).unwrap();
        assert!(load_or_create_key_with(&path, true, &|_| None, &protect_for_test).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), old);
        assert_eq!(load_for_test(&path).unwrap().to_bytes(), [0x42; 32]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn opening_failure_preserves_the_sealed_key_for_a_retry() {
        let dir = scratch("key-open-failure");
        let path = dir.join("remote-node.key");
        let key = load_for_test(&path).unwrap();
        let stored = std::fs::read(&path).unwrap();
        assert!(load_or_create_key_with(&path, true, &protect_for_test, &|_| None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), stored);
        assert!(load_or_create_key_with(&path, false, &|_| None, &|_| None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), stored);
        assert_eq!(load_for_test(&path).unwrap().public(), key.public());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn migration_write_failure_keeps_the_legacy_identity() {
        let dir = scratch("key-write-failure");
        let path = dir.join("remote-node.key");
        let old = "12".repeat(32);
        std::fs::write(&path, &old).unwrap();
        // A directory at the temporary path forces an I/O failure on every
        // platform without depending on user permissions or filesystem mode.
        let temp = path.with_file_name(format!("remote-node.key.tmp-{}", std::process::id()));
        std::fs::create_dir(&temp).unwrap();
        assert!(load_for_test(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), old);
        std::fs::remove_dir(&temp).unwrap();
        assert_eq!(load_for_test(&path).unwrap().to_bytes(), [0x12; 32]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_errors_leave_the_existing_path_untouched() {
        let dir = scratch("key-read-failure");
        let path = dir.join("remote-node.key");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), "unchanged").unwrap();
        assert!(load_for_test(&path).is_err());
        assert_eq!(std::fs::read_to_string(path.join("keep")).unwrap(), "unchanged");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn platforms_without_protection_keep_their_plaintext_format() {
        let dir = scratch("key-plain");
        let path = dir.join("remote-node.key");
        let key = load_or_create_key_with(&path, false, &|_| None, &|_| None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), to_hex(&key.to_bytes()));
        assert_eq!(load_or_create_key_with(&path, false, &|_| None, &|_| None).unwrap().public(), key.public());
        std::fs::remove_dir_all(&dir).unwrap();
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
    #[ignore = "requires an interactive Windows user profile with DPAPI available"]
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
