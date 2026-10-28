//! The Whisper models dictation can use: what's on offer, what's installed
//! (in the app's local data folder) and downloading or deleting them.

use flowcode_shared::i18n::tr;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub struct Model {
    pub id: &'static str,
    file: &'static str,
    pub size: u64,
    sha256: &'static str,
    pub recommended: bool,
}

/// ggerganov/whisper.cpp on Hugging Face. In the order a session prefers.
pub const CATALOG: [Model; 3] = [
    Model {
        id: "small-q5",
        file: "ggml-small-q5_1.bin",
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        recommended: true,
    },
    Model {
        id: "small",
        file: "ggml-small.bin",
        size: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        recommended: false,
    },
    Model {
        id: "base",
        file: "ggml-base.bin",
        size: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        recommended: false,
    },
];

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/// What `dictation_download_model` fails with when the user cancelled.
pub const CANCELLED: &str = "cancelled";

pub fn find(id: &str) -> Option<&'static Model> {
    CATALOG.iter().find(|m| m.id == id)
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| e.to_string())
}

/// Where `model` is (or would be) installed.
fn path_of(app: &AppHandle, model: &Model) -> Result<PathBuf, String> {
    dir(app).map(|d| d.join(model.file))
}

/// The file of an installed model: present, and whole.
pub fn installed_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let model = find(id)?;
    let path = path_of(app, model).ok()?;
    (std::fs::metadata(&path).ok()?.len() == model.size).then_some(path)
}

/// The first installed model of the catalog.
pub fn first_installed(app: &AppHandle) -> Option<&'static str> {
    CATALOG.iter().map(|m| m.id).find(|id| installed_path(app, id).is_some())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: &'static str,
    size_bytes: u64,
    installed: bool,
    recommended: bool,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    id: String,
    received: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationModels {
    models: Vec<ModelInfo>,
    downloading: Option<Progress>,
    /// The models folder.
    dir: String,
}

/// The download in progress, if any: only one runs at a time.
struct Active {
    id: String,
    total: u64,
    received: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Downloads(Mutex<Option<Active>>);

/// Ends the download's registration however its function returns.
struct Registered<'a>(&'a Downloads);

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        *self.0 .0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Downloads {
    pub fn cancel(&self) {
        if let Some(active) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            active.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn is_downloading(&self, id: &str) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|a| a.id == id)
    }
}

pub fn list(app: &AppHandle, downloads: &Downloads) -> DictationModels {
    let models = CATALOG
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            size_bytes: m.size,
            installed: installed_path(app, m.id).is_some(),
            recommended: m.recommended,
        })
        .collect();
    let downloading = downloads.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|a| Progress {
        id: a.id.clone(),
        received: a.received.load(Ordering::Relaxed),
        total: a.total,
    });
    let dir = dir(app).map(|d| d.display().to_string()).unwrap_or_default();
    DictationModels { models, downloading, dir }
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let model = find(id).ok_or_else(|| tr("Modello sconosciuto.", "Unknown model.").to_string())?;
    let path = path_of(app, model)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads `id` into the models folder: to `<file>.part`, checked against
/// the catalog's size and hash, then renamed into place. Blocks; reports to
/// every window as `dictation://download` `{ id, received, total }`, and a
/// last time with `done` ("installed", "cancelled" or "error", plus `message`).
pub fn download(app: &AppHandle, downloads: &Downloads, id: &str) -> Result<(), String> {
    let result = download_inner(app, downloads, id);
    if let Some(model) = find(id) {
        let (done, message) = match &result {
            Ok(()) => ("installed", None),
            Err(m) if m == CANCELLED => ("cancelled", None),
            Err(m) => ("error", Some(m.clone())),
        };
        let _ = app.emit(
            "dictation://download",
            json!({ "id": id, "received": if result.is_ok() { model.size } else { 0 }, "total": model.size, "done": done, "message": message }),
        );
    }
    result
}

fn download_inner(app: &AppHandle, downloads: &Downloads, id: &str) -> Result<(), String> {
    let model = find(id).ok_or_else(|| tr("Modello sconosciuto.", "Unknown model.").to_string())?;
    let active = Active {
        id: id.to_string(),
        total: model.size,
        received: Arc::new(AtomicU64::new(0)),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let (received, cancel) = (active.received.clone(), active.cancel.clone());
    {
        let mut slot = downloads.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err(tr("Un download è già in corso.", "A download is already in progress.").to_string());
        }
        *slot = Some(active);
    }
    let _registered = Registered(downloads);

    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(model.file);
    let part = dir.join(format!("{}.part", model.file));
    let result = fetch(app, model, &part, &received, &cancel);
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
        return result;
    }
    std::fs::rename(&part, &target).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })
}

fn fetch(
    app: &AppHandle,
    model: &Model,
    part: &std::path::Path,
    received: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let failed = |e: &dyn std::fmt::Display| {
        let base = tr("Download non riuscito", "Download failed");
        format!("{base}: {e}")
    };
    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .user_agent(concat!("flowcode/", env!("CARGO_PKG_VERSION")))
        .build()
        .get(&format!("{BASE_URL}/{}", model.file))
        .call()
        .map_err(|e| failed(&e))?;
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| failed(&e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_report = Instant::now();
    let report = |done: u64| {
        let _ = app.emit(
            "dictation://download",
            json!({ "id": model.id, "received": done, "total": model.size }),
        );
    };
    report(0);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let n = reader.read(&mut buf).map_err(|e| failed(&e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| failed(&e))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        received.store(done, Ordering::Relaxed);
        // About eight reports a second.
        if last_report.elapsed() >= Duration::from_millis(125) {
            last_report = Instant::now();
            report(done);
        }
    }
    file.flush().map_err(|e| failed(&e))?;
    drop(file);
    report(done);
    if done != model.size || hex(&hasher.finalize()) != model.sha256 {
        return Err(tr(
            "Il file scaricato è incompleto o danneggiato: riprova.",
            "The downloaded file is incomplete or corrupt: try again.",
        )
        .to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sane() {
        let mut ids: Vec<_> = CATALOG.iter().map(|m| m.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        for m in &CATALOG {
            assert!(m.size > 0);
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{}", m.id);
            assert!(m.file.ends_with(".bin"));
        }
        assert_eq!(CATALOG.iter().filter(|m| m.recommended).count(), 1);
    }

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex(&[0x0a, 0xff]), "0aff");
    }
}
