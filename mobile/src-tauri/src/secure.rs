//! Seals the phone's secrets with a non-exportable Android Keystore key. The
//! Kotlin side (`SecureStorePlugin`) does the crypto; elsewhere this is a
//! pass-through, like `store::Plain`.

use crate::store::{Codec, OpenError};
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Wry};

#[derive(Clone)]
pub struct SecureStore {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
}

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct Payload {
    data: String,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct Reply {
    data: String,
}

impl SecureStore {
    /// Blocks until the Kotlin command answers.
    #[cfg(target_os = "android")]
    fn call(&self, command: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let reply: Reply = self
            .handle
            .run_mobile_plugin(command, Payload { data: STANDARD.encode(bytes) })
            .map_err(|e| e.to_string())?;
        STANDARD.decode(reply.data).map_err(|e| e.to_string())
    }
}

/// Maps the Kotlin plugin's rejection (`KEY_MISSING: ...` / `BAD_DATA: ...` /
/// `TRANSIENT: ...`) to what the caller may do. Anything unrecognised counts as
/// transient: wrongly keeping a secret is recoverable, wrongly erasing is not.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn classify(message: &str) -> OpenError {
    if message.contains("KEY_MISSING") || message.contains("BAD_DATA") {
        OpenError::Lost(message.to_string())
    } else {
        OpenError::Transient(message.to_string())
    }
}

impl Codec for SecureStore {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        #[cfg(target_os = "android")]
        return self.call("seal", plain);
        #[cfg(not(target_os = "android"))]
        Ok(plain.to_vec())
    }

    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
        #[cfg(target_os = "android")]
        return self.call("open", sealed).map_err(|e| classify(&e));
        #[cfg(not(target_os = "android"))]
        Ok(sealed.to_vec())
    }

    fn seals(&self) -> bool {
        cfg!(target_os = "android")
    }
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("securestore")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "SecureStorePlugin")?;
                app.manage(SecureStore { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(SecureStore {});
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_definitive_codes_are_lost() {
        assert!(matches!(classify("KEY_MISSING: no key under the alias"), OpenError::Lost(_)));
        assert!(matches!(classify("BAD_DATA: Tag mismatch"), OpenError::Lost(_)));
        assert!(matches!(classify("TRANSIENT: keystore busy"), OpenError::Transient(_)));
        assert!(matches!(classify("something else"), OpenError::Transient(_)));
    }
}
