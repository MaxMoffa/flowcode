//! Reconnect timing: how often the link is pinged, when it counts as dead,
//! and how long to wait between redials.

use std::time::Duration;

pub(crate) const PING_EVERY: Duration = Duration::from_secs(20);
/// Pongs answer our pings, so 60 s of total silence means the link is dead
/// even though QUIC has not noticed yet. (The QUIC idle timeout is 90 s, see
/// `link::IDLE_TIMEOUT`, so this timer always fires first.)
pub(crate) const DEAD_AFTER: Duration = Duration::from_secs(60);
/// When the app comes back to the foreground the link may be a zombie (the OS
/// froze the process, or Wi-Fi/mobile data switched meanwhile): a ping must be
/// answered within this long or the link is dropped and redialed at once.
/// (Right after a network switch the first round trip can take several
/// seconds, so a shorter fuse falsely killed healthy links.)
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A link that dies sooner than this after coming online counts as a failed
/// attempt for the backoff (a desktop that accepts and immediately hangs up
/// must not be redialed once a second forever).
pub(crate) const STABLE_AFTER: Duration = Duration::from_secs(10);
/// After this many consecutive failed dials the iroh endpoint is rebuilt:
/// its sockets may be bound to a network that no longer exists.
pub(crate) const REBUILD_ENDPOINT_EVERY: u32 = 4;

/// Reconnect delay after `failures` consecutive failures (>= 1): 1, 2, 4, 8 s
/// and then 8 s. Kept low on purpose: someone is looking at the phone. With
/// the app hidden and nothing keeping it alive (`idle`) nobody is, so it
/// goes on to 16 and then 30 s to spare the battery.
pub(crate) fn backoff_delay(failures: u32, idle: bool) -> Duration {
    let exp = failures.saturating_sub(1).min(if idle { 5 } else { 3 });
    Duration::from_secs((1u64 << exp).min(if idle { 30 } else { 8 }))
}

/// Failure count after a link that was online for `lived` ended: a link that
/// held is a fresh start; one that died at once keeps counting.
pub(crate) fn failures_after_link(failures: u32, lived: Duration) -> u32 {
    if lived >= STABLE_AFTER {
        1
    } else {
        failures + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_eight_seconds() {
        let secs: Vec<u64> = (0..7).map(|f| backoff_delay(f, false).as_secs()).collect();
        assert_eq!(secs, [1, 1, 2, 4, 8, 8, 8]);
        let idle: Vec<u64> = (0..8).map(|f| backoff_delay(f, true).as_secs()).collect();
        assert_eq!(idle, [1, 1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn a_link_that_dies_at_once_keeps_the_backoff_growing() {
        assert_eq!(failures_after_link(3, Duration::from_secs(2)), 4);
        assert_eq!(failures_after_link(3, Duration::from_secs(600)), 1);
    }
}
