//! The agent view plugins (see view_plugins.rs) a phone may show: the
//! listing, with a hash per package so the phone re-downloads only what
//! changed, and the files, in chunks.

use std::path::{Path, PathBuf};

use base64::Engine;
use flowcode_remote_proto::{ServerMsg, ViewFileInfo, ViewPackage};
use flowcode_shared::i18n::tr;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::hex::to_hex;
use crate::view_plugins::{self, ViewPluginManifest, MAX_FILE_BYTES};

/// Raw bytes of a file in one `viewfile` message: about 256 KiB once base64
/// encoded, a quarter of a frame.
const CHUNK_BYTES: usize = 192 * 1024;

/// Whether the view lists a device a phone app counts as.
fn for_phones(manifest: &ViewPluginManifest) -> bool {
    manifest.devices.iter().any(|d| d == "phone" || d == "tablet")
}

/// Every file under `root` as (path with forward slashes, location), sorted
/// by path. Symlinks are left out.
fn package_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    let mut dirs = vec![PathBuf::new()];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&dir)) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let relative = dir.join(entry.file_name());
            if kind.is_dir() {
                dirs.push(relative);
            } else if kind.is_file() {
                let path = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                files.push((path, root.join(&relative)));
            }
        }
    }
    files.sort();
    files
}

/// The manifest with the package's files and their hash: SHA-256 over each
/// file in path order - its path, a NUL, its length (u64, little endian) and
/// its bytes.
fn package_of(root: &Path, manifest: ViewPluginManifest) -> ViewPackage {
    let mut hasher = Sha256::new();
    let mut files = Vec::new();
    for (path, file) in package_files(root) {
        let Ok(bytes) = std::fs::read(file) else { continue };
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
        files.push(ViewFileInfo { path, size: bytes.len() as u64 });
    }
    ViewPackage {
        id: manifest.id,
        kind: manifest.kind,
        api_version: manifest.api_version,
        label: manifest.label,
        labels: Some(manifest.labels).filter(|labels| !labels.is_empty()),
        description: Some(manifest.description).filter(|d| !d.is_empty()),
        version: Some(manifest.version).filter(|v| !v.is_empty()),
        author: Some(manifest.author).filter(|a| !a.is_empty()),
        entry: manifest.entry,
        transport: manifest.transport,
        devices: manifest.devices,
        permissions: manifest.permissions,
        hash: to_hex(&hasher.finalize()),
        files,
    }
}

/// The installed views that list a phone or a tablet, by id. Reads every
/// file: run it off the async threads.
pub(super) fn list(app: &AppHandle) -> Result<Vec<ViewPackage>, String> {
    let dir = view_plugins::views_dir(app)?;
    Ok(view_plugins::view_plugins_list(app.clone())?
        .into_iter()
        .filter(for_phones)
        .map(|manifest| {
            let root = dir.join(&manifest.id);
            package_of(&root, manifest)
        })
        .collect())
}

/// One file of a view a phone may show, and the hash of its package -
/// `known_hash` if the caller has it, else worked out here. Reads the file:
/// run it off the async threads.
pub(super) fn read_file(app: &AppHandle, id: &str, path: &str, known_hash: Option<String>) -> Result<(String, Vec<u8>), String> {
    if !view_plugins::valid_id(id) {
        return Err(tr("Id della vista non valido", "Invalid view id").to_string());
    }
    let Some(relative) = view_plugins::sanitize_path(path) else {
        return Err(tr("Percorso non valido", "Invalid path").to_string());
    };
    let dir = view_plugins::views_dir(app)?;
    let root = dir.join(id);
    let manifest = view_plugins::read_manifest(&root)?;
    if manifest.id != id || !for_phones(&manifest) {
        return Err(tr("Vista non disponibile sul telefono", "View not available on phones").to_string());
    }
    let not_found = || tr("File non trovato", "File not found").to_string();
    let file = view_plugins::resolve_file(&dir, id, &relative).ok_or_else(not_found)?;
    if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES as u64 {
        return Err(tr("File troppo grande", "File too large").to_string());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let hash = known_hash.unwrap_or_else(|| package_of(&root, manifest).hash);
    Ok((hash, bytes))
}

/// Queues a file as `viewfile` chunks, in order (an empty file is one empty
/// chunk). False when the connection is gone.
pub(super) async fn send_file(out: &mpsc::Sender<ServerMsg>, view_id: &str, hash: &str, path: &str, bytes: &[u8]) -> bool {
    let total = bytes.len() as u64;
    let mut offset = 0;
    loop {
        let end = (offset + CHUNK_BYTES).min(bytes.len());
        let msg = ServerMsg::ViewFile {
            view_id: view_id.to_string(),
            hash: hash.to_string(),
            path: path.to_string(),
            offset: offset as u64,
            total,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]),
        };
        if out.send(msg).await.is_err() {
            return false;
        }
        offset = end;
        if offset >= bytes.len() {
            return true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ViewPluginManifest {
        serde_json::from_str(
            r#"{ "id": "timeline", "kind": "agentView", "apiVersion": 1, "label": "Timeline",
                 "entry": "index.html", "transport": "acp", "devices": ["desktop", "phone"] }"#,
        )
        .unwrap()
    }

    #[test]
    fn packages_list_their_files_and_hash_changes_with_them() {
        let root = super::super::scratch("views");
        std::fs::create_dir_all(root.join("js")).unwrap();
        std::fs::write(root.join("index.html"), "<html>").unwrap();
        std::fs::write(root.join("js").join("app.js"), "1").unwrap();

        let package = package_of(&root, manifest());
        let paths: Vec<&str> = package.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["index.html", "js/app.js"]);
        assert_eq!(package.files[0].size, 6);
        assert_eq!(package.hash.len(), 64);
        assert!(package.description.is_none() && package.labels.is_none());
        assert_eq!(package.hash, package_of(&root, manifest()).hash);

        std::fs::write(root.join("js").join("app.js"), "2").unwrap();
        assert_ne!(package.hash, package_of(&root, manifest()).hash);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_phone_and_tablet_views_are_offered() {
        assert!(for_phones(&manifest()));
        let mut desktop = manifest();
        desktop.devices = vec!["desktop".into()];
        assert!(!for_phones(&desktop));
        desktop.devices = vec!["tablet".into()];
        assert!(for_phones(&desktop));
    }

    #[tokio::test]
    async fn files_go_out_in_ordered_chunks() {
        let (tx, mut rx) = mpsc::channel(8);
        let bytes = vec![7u8; CHUNK_BYTES + 10];
        assert!(send_file(&tx, "v", "h", "a.js", &bytes).await);
        assert!(send_file(&tx, "v", "h", "empty.txt", &[]).await);
        drop(tx);
        let mut got = Vec::new();
        while let Some(ServerMsg::ViewFile { path, offset, total, data, .. }) = rx.recv().await {
            let raw = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
            got.push((path, offset, total, raw.len()));
        }
        assert_eq!(
            got,
            [
                ("a.js".to_string(), 0, bytes.len() as u64, CHUNK_BYTES),
                ("a.js".to_string(), CHUNK_BYTES as u64, bytes.len() as u64, 10),
                ("empty.txt".to_string(), 0, 0, 0),
            ]
        );
    }
}
