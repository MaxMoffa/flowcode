//! Paired devices and the rules around them: the persisted device list,
//! one-time pairing codes, and rate limits on wrong codes and tokens.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::hex::{ct_eq, hash_token, random_hex};

/// A pairing code is good for this long, once.
pub(super) const PAIR_TTL_MS: u64 = 5 * 60 * 1000;

/// After this many wrong codes within `FAIL_WINDOW_MS`, every pairing attempt
/// is refused for `BLOCK_MS`.
pub(super) const MAX_PAIR_FAILURES: usize = 5;

pub(super) const FAIL_WINDOW_MS: u64 = 60_000;

pub(super) const BLOCK_MS: u64 = 60_000;

/// After this many failed `auth`s from one node within `FAIL_WINDOW_MS`, its
/// `auth` is refused for `BLOCK_MS`.
pub(super) const MAX_AUTH_FAILURES: u32 = 5;

/// `remote_pair_start` called again within this long returns the same code:
/// a double call (React StrictMode) must not invalidate the code on screen.
pub(super) const PAIR_REUSE_MS: u64 = 10_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct Device {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) token_hash: String,
    /// iroh node id (the phone's public key) the token was issued to. A
    /// device saved by the Tailscale prototype has none and is dropped.
    #[serde(default)]
    pub(super) node_id: String,
    pub(super) created_at: u64,
    pub(super) last_seen_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct Config {
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) devices: Vec<Device>,
}

impl Config {
    /// The device `token` was issued to, if `node_id` is the node that
    /// paired with it. Both must match.
    pub(super) fn authenticate(&self, token: &str, node_id: &str) -> Option<Device> {
        let hash = hash_token(token);
        // Compare against every device (no early exit) so timing doesn't
        // reveal how far down the list a match was.
        let mut found = None;
        for device in &self.devices {
            let token_ok = ct_eq(device.token_hash.as_bytes(), hash.as_bytes());
            let node_ok = !device.node_id.is_empty() && ct_eq(device.node_id.as_bytes(), node_id.as_bytes());
            if token_ok && node_ok {
                found = Some(device.clone());
            }
        }
        found
    }

    /// Adds a device for `node_id`, replacing an earlier pairing of the same
    /// phone (re-scanning must not leave a stale duplicate). Returns the new
    /// device and the token that was issued (only its hash is kept).
    pub(super) fn add_device(&mut self, name: &str, node_id: &str, now: u64) -> Result<(Device, String), String> {
        let token = random_hex(32)?;
        let name = clean_name(name);
        let device = Device {
            id: random_hex(8)?,
            name: if name.is_empty() { "Phone".to_string() } else { name },
            token_hash: hash_token(&token),
            node_id: node_id.to_string(),
            created_at: now,
            last_seen_at: None,
        };
        self.devices.retain(|d| d.node_id != node_id);
        self.devices.push(device.clone());
        Ok((device, token))
    }
}

/// A device name from the phone, safe to show: no control characters (they
/// could fake lines in a dialog or notification), trimmed, at most 64 chars.
pub(super) fn clean_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(64).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PairError {
    Invalid,
    RateLimited,
}

/// The one active pairing code plus the failure bookkeeping. Time is passed
/// in (`now`, ms) so the rules are testable.
#[derive(Default)]
pub(super) struct Pairings {
    pub(super) active: Option<(String, u64)>,
    /// When `active` was generated.
    started_at: u64,
    /// The code that was last redeemed. Asking for it again (a phone retrying
    /// after the user declined or let the confirmation time out) is just
    /// invalid, not a guess, so it doesn't count towards the rate limit.
    spent: Option<String>,
    failures: Vec<u64>,
    blocked_until: u64,
}

impl Pairings {
    /// A fresh code, replacing any earlier one. Returns (code, expiresAt).
    pub(super) fn start(&mut self, code: String, now: u64) -> (String, u64) {
        let expires = now + PAIR_TTL_MS;
        self.active = Some((code.clone(), expires));
        self.started_at = now;
        self.spent = None;
        (code, expires)
    }

    /// The active code if it is still unexpired and was generated less than
    /// `PAIR_REUSE_MS` ago: what a repeated start returns.
    pub(super) fn recent(&self, now: u64) -> Option<(String, u64)> {
        let (code, expires) = self.active.as_ref()?;
        (now < *expires && now.saturating_sub(self.started_at) < PAIR_REUSE_MS).then(|| (code.clone(), *expires))
    }

    /// Consumes the code if `code` is the active, unexpired one.
    pub(super) fn redeem(&mut self, code: &str, now: u64) -> Result<(), PairError> {
        if now < self.blocked_until {
            return Err(PairError::RateLimited);
        }
        let hit = match &self.active {
            Some((active, expires)) => ct_eq(active.as_bytes(), code.as_bytes()) && now < *expires,
            None => false,
        };
        if hit {
            self.spent = self.active.take().map(|(code, _)| code);
            self.failures.clear();
            return Ok(());
        }
        if matches!(&self.spent, Some(spent) if ct_eq(spent.as_bytes(), code.as_bytes())) {
            return Err(PairError::Invalid);
        }
        if matches!(&self.active, Some((_, expires)) if now >= *expires) {
            self.active = None;
        }
        self.failures.retain(|t| now.saturating_sub(*t) < FAIL_WINDOW_MS);
        self.failures.push(now);
        if self.failures.len() >= MAX_PAIR_FAILURES {
            self.blocked_until = now + BLOCK_MS;
            self.failures.clear();
        }
        Err(PairError::Invalid)
    }
}

/// Failed `auth`s per node id. A real phone with a stale token retries on a
/// backoff; a stranger guessing tokens is slowed to a crawl (the 256-bit
/// token is the real defence, this just keeps the log and CPU calm).
#[derive(Default)]
pub(super) struct AuthLimiter {
    /// node id -> (failures in the current window, window start, blocked until)
    nodes: HashMap<String, (u32, u64, u64)>,
}

impl AuthLimiter {
    pub(super) fn allowed(&self, node: &str, now: u64) -> bool {
        self.nodes.get(node).is_none_or(|(_, _, blocked_until)| now >= *blocked_until)
    }

    pub(super) fn failed(&mut self, node: &str, now: u64) {
        // Bounded: unknown nodes are free to make up ids.
        if self.nodes.len() >= 1024 {
            self.nodes.retain(|_, (_, start, blocked)| now < *blocked || now.saturating_sub(*start) < FAIL_WINDOW_MS);
            if self.nodes.len() >= 1024 {
                self.nodes.clear();
            }
        }
        let entry = self.nodes.entry(node.to_string()).or_insert((0, now, 0));
        if now.saturating_sub(entry.1) >= FAIL_WINDOW_MS {
            *entry = (0, now, entry.2);
        }
        entry.0 += 1;
        if entry.0 >= MAX_AUTH_FAILURES {
            entry.2 = now + BLOCK_MS;
            entry.0 = 0;
        }
    }

    pub(super) fn succeeded(&mut self, node: &str) {
        self.nodes.remove(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_code_is_single_use_and_expires() {
        let mut p = Pairings::default();
        let (code, expires) = p.start("c0de".into(), 1_000);
        assert_eq!(expires, 1_000 + PAIR_TTL_MS);
        assert_eq!(p.redeem(&code, 2_000), Ok(()));
        assert_eq!(p.redeem(&code, 3_000), Err(PairError::Invalid));

        let (code, expires) = p.start("beef".into(), 10_000);
        assert_eq!(p.redeem(&code, expires), Err(PairError::Invalid));
        // Expired codes are gone for good, even if asked again "in time".
        assert_eq!(p.redeem(&code, 10_001), Err(PairError::Invalid));

        // A new code replaces the old one.
        p.start("aaaa".into(), 20_000);
        p.start("bbbb".into(), 20_001);
        assert_eq!(p.redeem("aaaa", 20_002), Err(PairError::Invalid));
        assert_eq!(p.redeem("bbbb", 20_003), Ok(()));
    }

    #[test]
    fn pairing_failures_are_rate_limited() {
        let mut p = Pairings::default();
        p.start("good".into(), 0);
        for i in 0..MAX_PAIR_FAILURES as u64 {
            assert_eq!(p.redeem("bad", 100 + i), Err(PairError::Invalid));
        }
        // Blocked: even the right code is refused...
        assert_eq!(p.redeem("good", 1_000), Err(PairError::RateLimited));
        // ...until the block ends.
        assert_eq!(p.redeem("good", 200 + BLOCK_MS), Ok(()));
    }

    #[test]
    fn old_failures_do_not_count() {
        let mut p = Pairings::default();
        for i in 0..(MAX_PAIR_FAILURES as u64 - 1) {
            assert_eq!(p.redeem("bad", i), Err(PairError::Invalid));
        }
        // The window has passed: this is failure #1 again, not #5.
        assert_eq!(p.redeem("bad", FAIL_WINDOW_MS + 100), Err(PairError::Invalid));
        assert_eq!(p.redeem("bad", FAIL_WINDOW_MS + 101), Err(PairError::Invalid));
    }

    #[test]
    fn token_is_bound_to_the_node_that_paired() {
        let mut config = Config::default();
        let (device, token) = config.add_device("  Pixel  ", "node-a", 5).unwrap();
        assert_eq!(device.name, "Pixel");
        // The right token from the right node.
        assert_eq!(config.authenticate(&token, "node-a").map(|d| d.id), Some(device.id.clone()));
        // A stolen token from another node is useless...
        assert!(config.authenticate(&token, "node-b").is_none());
        // ...and so is the right node with a wrong token.
        assert!(config.authenticate("nope", "node-a").is_none());
        // Only the hash is stored.
        assert!(config.devices.iter().all(|d| d.token_hash != token));
    }

    #[test]
    fn a_device_without_a_node_id_never_authenticates() {
        let mut config = Config::default();
        let (mut device, token) = config.add_device("Old", "node-a", 5).unwrap();
        device.node_id = String::new();
        config.devices = vec![device];
        assert!(config.authenticate(&token, "").is_none());
        assert!(config.authenticate(&token, "node-a").is_none());
    }

    #[test]
    fn pairing_again_from_the_same_node_replaces_the_device() {
        let mut config = Config::default();
        let (_, first) = config.add_device("Phone", "node-a", 1).unwrap();
        let (second, token) = config.add_device("Phone", "node-a", 2).unwrap();
        assert_eq!(config.devices.len(), 1);
        assert!(config.authenticate(&first, "node-a").is_none());
        assert_eq!(config.authenticate(&token, "node-a").map(|d| d.id), Some(second.id));
        config.add_device("Tablet", "node-b", 3).unwrap();
        assert_eq!(config.devices.len(), 2);
    }

    #[test]
    fn device_names_are_sanitized() {
        assert_eq!(clean_name("  Pixel 8\n\u{7}\u{1b}[2J "), "Pixel 8[2J");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 64);
        assert_eq!(clean_name("\n\t"), "");
    }

    #[test]
    fn a_repeated_pair_start_reuses_the_fresh_code() {
        let mut p = Pairings::default();
        let (code, expires) = p.start("first".into(), 1_000);
        // Within the reuse window: same code, same expiry.
        assert_eq!(p.recent(1_000 + PAIR_REUSE_MS - 1), Some((code, expires)));
        // Past it, or once used or cancelled, a new one is needed.
        assert_eq!(p.recent(1_000 + PAIR_REUSE_MS), None);
        p.start("second".into(), 50_000);
        assert_eq!(p.redeem("second", 50_001), Ok(()));
        assert_eq!(p.recent(50_002), None);
        p.start("third".into(), 60_000);
        p.active = None;
        assert_eq!(p.recent(60_001), None);
    }

    #[test]
    fn retrying_a_spent_code_is_not_a_guess() {
        let mut p = Pairings::default();
        p.start("good".into(), 0);
        assert_eq!(p.redeem("good", 10), Ok(()));
        // The phone retries after the user declined: invalid, but never blocks.
        for i in 0..(MAX_PAIR_FAILURES as u64 * 2) {
            assert_eq!(p.redeem("good", 20 + i), Err(PairError::Invalid));
        }
        p.start("next".into(), 1_000);
        assert_eq!(p.redeem("next", 1_001), Ok(()));
        // Real guesses still count.
        p.start("again".into(), 2_000);
        for i in 0..MAX_PAIR_FAILURES as u64 {
            assert_eq!(p.redeem("wrong", 2_001 + i), Err(PairError::Invalid));
        }
        assert_eq!(p.redeem("again", 2_100), Err(PairError::RateLimited));
    }

    #[test]
    fn failed_auths_block_only_that_node() {
        let mut l = AuthLimiter::default();
        for i in 0..MAX_AUTH_FAILURES as u64 {
            assert!(l.allowed("a", i));
            l.failed("a", i);
        }
        assert!(!l.allowed("a", 100));
        assert!(l.allowed("b", 100));
        assert!(l.allowed("a", 10 + BLOCK_MS));
        // A success forgets the failures.
        l.failed("b", 200);
        l.succeeded("b");
        assert!(!l.nodes.contains_key("b"));
    }
}
