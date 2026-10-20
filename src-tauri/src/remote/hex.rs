//! Small helpers for random ids, hex, and token hashing and comparison.

use sha2::{Digest, Sha256};

pub(super) fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(to_hex(&buf))
}

pub(super) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Equality that doesn't leak, through timing, where two strings first differ.
pub(super) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_and_constant_time_compare() {
        // Known SHA-256 of "abc".
        assert_eq!(hash_token("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(ct_eq(b"same", b"same"));
        assert!(!ct_eq(b"same", b"sama"));
        assert!(!ct_eq(b"same", b"sam"));
        assert_eq!(random_hex(32).unwrap().len(), 64);
    }
}
