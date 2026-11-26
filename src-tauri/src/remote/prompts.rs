//! Bounded, reconnect-safe receipts for prompts sent by a paired device.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

const RETRY_MS: u64 = 15 * 60 * 1000;
/// A receipt lives this long from the moment the HOST first saw its id. The id embeds the sender's clock,
/// which is not trusted (a skewed PC or phone must still be able to send), so expiry never reads it; the
/// window is long (a client may retry a queued message after hours offline) so a late retry of a prompt
/// that was already delivered is still recognised instead of running twice; `MAX_RECEIPTS` bounds memory.
const KEEP_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS: usize = 4096;

struct Receipt {
    timestamp: u64,
    digest: [u8; 32],
    result: Arc<OnceCell<Result<(), String>>>,
}

#[derive(Default)]
pub(super) struct PromptReceipts(Mutex<HashMap<(String, String, String), Receipt>>);

impl PromptReceipts {
    fn reserve(&self, device: &str, chat: &str, id: &str, text: &str, now: u64) -> Result<Arc<OnceCell<Result<(), String>>>, String> {
        // Only the shape is checked (`<number>-<suffix>`); the number is the client's clock and is ignored.
        id.split_once('-').and_then(|(time, suffix)| (!suffix.is_empty()).then_some(time)).and_then(|s| s.parse::<u64>().ok())
            .filter(|_| id.len() <= 128)
            .ok_or_else(|| "Invalid prompt request id".to_string())?;
        let timestamp = now;
        let mut receipts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        receipts.retain(|_, r| now.saturating_sub(r.timestamp) <= KEEP_MS);
        let key = (device.to_string(), chat.to_string(), id.to_string());
        let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        if let Some(receipt) = receipts.get(&key) {
            return if receipt.digest == digest { Ok(Arc::clone(&receipt.result)) } else { Err("Prompt request id reused with different content".into()) };
        }
        if receipts.len() >= MAX_RECEIPTS {
            return Err("Too many prompt receipts; retry later".into());
        }
        let result = Arc::new(OnceCell::new());
        receipts.insert(key, Receipt { timestamp, digest, result: Arc::clone(&result) });
        Ok(result)
    }

    pub(super) async fn run<F, Fut>(&self, device: &str, chat: &str, id: &str, text: &str, work: F) -> Result<(), String>
    where F: FnOnce() -> Fut, Fut: Future<Output = Result<(), String>> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis() as u64;
        let receipt = self.reserve(device, chat, id, text, now)?;
        receipt.get_or_init(work).await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn duplicate_requests_share_one_delivery_and_result() {
        let receipts = PromptReceipts::default();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let id = format!("{now}-a");
        let calls = AtomicUsize::new(0);
        let work = || async { calls.fetch_add(1, Ordering::SeqCst); tokio::task::yield_now().await; Ok(()) };
        let (a, b) = tokio::join!(receipts.run("d", "c", &id, "hello", work), receipts.run("d", "c", &id, "hello", work));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(receipts.run("d", "c", &id, "different", || async { Ok(()) }).await.is_err());
    }

    #[test]
    fn receipts_are_scoped_and_expired_ids_never_execute_again() {
        let receipts = PromptReceipts::default();
        let now = RETRY_MS + 10;
        let id = format!("{now}-x");
        let first = receipts.reserve("a", "c", &id, "x", now).unwrap();
        assert!(Arc::ptr_eq(&first, &receipts.reserve("a", "c", &id, "x", now).unwrap()));
        assert!(!Arc::ptr_eq(&first, &receipts.reserve("b", "c", &id, "x", now).unwrap()));
        assert!(receipts.reserve("a", "c", "bad", "x", now).is_err());
        // Expiry counts from the host's first sight: a retry inside the window shares the receipt, a much later one is new.
        assert!(Arc::ptr_eq(&first, &receipts.reserve("a", "c", &id, "x", now + RETRY_MS).unwrap()));
        let later = receipts.reserve("a", "c", &id, "x", now + KEEP_MS + 1).unwrap();
        assert!(!Arc::ptr_eq(&first, &later));
    }

    #[test]
    fn a_skewed_client_clock_is_not_rejected() {
        let receipts = PromptReceipts::default();
        let now = 10 * RETRY_MS;
        // A client an hour behind and a day ahead of the host.
        assert!(receipts.reserve("d", "c", &format!("{}-a", now - 4 * RETRY_MS), "x", now).is_ok());
        assert!(receipts.reserve("d", "c", &format!("{}-b", now + 96 * RETRY_MS), "x", now).is_ok());
    }

    #[test]
    fn live_receipts_are_not_evicted_to_accept_more_requests() {
        let receipts = PromptReceipts::default();
        let now = RETRY_MS;
        for n in 0..MAX_RECEIPTS {
            receipts.reserve("d", "c", &format!("{now}-{n}"), "x", now).unwrap();
        }
        assert!(receipts.reserve("d", "c", &format!("{now}-overflow"), "x", now).is_err());
        assert!(receipts.reserve("d", "c", &format!("{now}-0"), "x", now).is_ok());
        let later = now + KEEP_MS + 1;
        assert!(receipts.reserve("d", "c", &format!("{later}-new"), "x", later).is_ok());
    }
}
