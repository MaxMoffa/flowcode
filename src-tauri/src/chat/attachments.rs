//! Files sent along with a prompt: staging, quota and ACP blocks.

use super::*;

/// A file sent along with a prompt: its bytes (base64), a path on this PC, or
/// the id of a file `chat_stage_attachment` stored (`upload`).
#[derive(Deserialize, Debug)]
pub(crate) struct Attachment {
    pub(super) name: String,
    pub(super) mime: String,
    pub(super) data: Option<String>,
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) upload: Option<String>,
}

/// A name that is safe as a single path component.
pub(super) fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "attachment".into() } else { clean }
}

/// `file:///C:/x%20y` for an absolute path (percent-encoded, forward slashes).
pub(super) fn file_uri(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let raw = raw.strip_prefix("//?/").unwrap_or(&raw);
    let mut uri = String::from("file://");
    if !raw.starts_with('/') {
        uri.push('/');
    }
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// The ACP content blocks for one attachment: a `resource_link` to the file
/// (the baseline every agent accepts; it opens the file with its own tools),
/// preceded by an inline `image` when it is a picture and the agent takes them. For an agent running
/// in WSL (`wsl`) the link is the file's Linux path (`/mnt/c/...` for a
/// Windows file), the only kind it can open.
pub(super) const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
pub(super) const MAX_ATTACHMENTS_TOTAL: u64 = 256 * 1024 * 1024;
/// Total bytes of the staged files (`None`: not measured yet); the lock also serialises the store.
pub(super) static ATTACHMENT_STORE: Mutex<Option<u64>> = Mutex::new(None);
pub(super) const ATTACHMENT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub(super) fn attachments_root() -> std::path::PathBuf {
    // The app's private cache folder (see `chat_images::init`), not the shared temp one.
    crate::chat_images::private_base().join("chat-attachments")
}

pub(super) fn root_is_safe(root: &std::path::Path) -> bool {
    if !crate::fs::links_stay_local(root) || std::fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return false;
    }
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(root) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // Ours (same owner as the folder it sits in) and closed to everyone else.
        let owner_ok = root.parent().and_then(|p| std::fs::metadata(p).ok()).is_none_or(|p| p.uid() == meta.uid());
        if !owner_ok || meta.permissions().mode() & 0o077 != 0 { return false; }
    }
    true
}

/// Bytes of the files directly inside `dir`.
pub(super) fn dir_files_size(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir).map(|files| {
        files.flatten().filter_map(|f| f.metadata().ok()).fold(0u64, |t, m| t.saturating_add(m.len()))
    }).unwrap_or(0)
}

/// Measures every staged directory.
pub(super) fn scan_attachments_total(root: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    entries.flatten()
        .filter(|e| e.file_type().is_ok_and(|kind| kind.is_dir()))
        .fold(0u64, |t, e| t.saturating_add(dir_files_size(&e.path())))
}

/// Removes the staged directories older than `max_age`; returns the bytes freed.
pub(super) fn purge_stale(root: &std::path::Path, max_age: Duration) -> u64 {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let mut freed = 0u64;
    for entry in entries.flatten() {
        if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() { continue; }
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|mtime| mtime.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if old {
            let size = dir_files_size(&entry.path());
            if std::fs::remove_dir_all(entry.path()).is_ok() { freed = freed.saturating_add(size); }
        }
    }
    freed
}

pub(crate) fn purge_attachments() {
    let mut total = lock(&ATTACHMENT_STORE);
    let root = attachments_root();
    if !root_is_safe(&root) { return; }
    purge_stale(&root, ATTACHMENT_MAX_AGE);
    *total = Some(scan_attachments_total(&root));
}

/// Saves `bytes` as `<root>/<uuid>/<name>`; returns the uuid and the file.
pub(super) fn stage_in(root: &std::path::Path, total: &mut Option<u64>, max_age: Duration, name: &str, bytes: &[u8]) -> Result<(String, std::path::PathBuf), String> {
    if bytes.len() > MAX_ATTACHMENT_BYTES { return Err("attachment exceeds 32 MiB".into()); }
    if !root.exists() {
        crate::chat_images::create_private_dir(root).map_err(|e| format!("could not create the attachment directory: {e}"))?;
    }
    if !root_is_safe(root) { return Err("unsafe attachment directory".into()); }
    let len = bytes.len() as u64;
    let mut current = *total.get_or_insert_with(|| scan_attachments_total(root));
    if current.saturating_add(len) > MAX_ATTACHMENTS_TOTAL {
        purge_stale(root, max_age);
        current = scan_attachments_total(root);
        *total = Some(current);
        if current.saturating_add(len) > MAX_ATTACHMENTS_TOTAL {
            return Err("the attachment store (256 MiB) is full of recent attachments (files are removed after 24 hours); remove some attachments and try again".into());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not save {name}: {e}"))?;
    let file = dir.join(sanitize_name(name));
    if let Err(e) = std::fs::write(&file, bytes) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("could not save {name}: {e}"));
    }
    *total = Some(current.saturating_add(len));
    Ok((id, file))
}

/// Deletes a staged upload (a missing one is fine) and frees its bytes.
pub(super) fn unstage_in(root: &std::path::Path, total: &mut Option<u64>, upload: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(upload).map_err(|_| "invalid attachment id".to_string())?;
    if !root_is_safe(root) { return Err("unsafe attachment directory".into()); }
    let dir = root.join(upload);
    if std::fs::symlink_metadata(&dir).is_err() { return Ok(()); }
    let size = dir_files_size(&dir);
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove the attachment: {e}"))?;
    if let Some(t) = total.as_mut() { *t = t.saturating_sub(size); }
    Ok(())
}

/// Saves `bytes` as `<private cache>/chat-attachments/<uuid>/<name>`; returns the uuid and the file.
pub(super) fn stage_attachment(name: &str, bytes: &[u8]) -> Result<(String, std::path::PathBuf), String> {
    let mut total = lock(&ATTACHMENT_STORE);
    stage_in(&attachments_root(), &mut total, ATTACHMENT_MAX_AGE, name, bytes)
}

pub(super) fn unstage_attachment(upload: &str) -> Result<(), String> {
    let mut total = lock(&ATTACHMENT_STORE);
    unstage_in(&attachments_root(), &mut total, upload)
}

/// Stores a file the phone uploaded; returns its id for `uploaded_attachment`.
pub(crate) fn stage_upload(name: &str, bytes: &[u8]) -> Result<String, String> {
    stage_attachment(name, bytes).map(|(id, _)| id)
}

/// The attachment a phone prompt refers to: a file `stage_upload` stored.
pub(crate) fn uploaded_attachment(id: &str, name: &str, mime: &str) -> Result<Attachment, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "invalid attachment id".to_string())?;
    let root = attachments_root();
    if !root_is_safe(&root) { return Err("unsafe attachment directory".into()); }
    let path = root.join(id).join(sanitize_name(name));
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_file() => {}
        _ => return Err(format!("attachment {name} not found")),
    }
    let valid = !mime.is_empty() && mime.len() <= 127 && mime.chars().all(|c| c.is_ascii_alphanumeric() || "!#$&^_.+-/".contains(c));
    let mime = if valid { mime } else { "application/octet-stream" };
    Ok(Attachment { name: name.into(), mime: mime.into(), data: None, path: Some(path.to_string_lossy().into_owned()), upload: None })
}

pub(super) fn attachment_blocks(a: &Attachment, images: bool, wsl: bool) -> Result<Vec<Value>, String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    if a.data.as_ref().is_some_and(|data| data.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4) {
        return Err("attachment exceeds 32 MiB".into());
    }
    let (path, bytes) = match (&a.data, &a.path) {
        (Some(data), _) => {
            let bytes = b64.decode(data).map_err(|e| format!("bad attachment {}: {e}", a.name))?;
            (stage_attachment(&a.name, &bytes)?.1, Some(bytes))
        }
        (None, Some(path)) => (std::path::PathBuf::from(path), None),
        _ => return Err(format!("attachment {} has no content", a.name)),
    };
    let uri = match wsl.then(|| to_wsl_path(&path.to_string_lossy())).flatten() {
        Some(posix) => file_uri(std::path::Path::new(&posix)),
        None => file_uri(&path),
    };
    let link = json!({ "type": "resource_link", "uri": uri, "name": a.name, "mimeType": a.mime });
    if images && a.mime.starts_with("image/") {
        let bytes = match bytes { Some(bytes) => bytes, None => crate::chat_images::read_file(&path)? };
        // Inline so the agent sees it at once, plus the link so its tools can use the file.
        return Ok(vec![json!({ "type": "image", "mimeType": a.mime, "data": b64.encode(bytes) }), link]);
    }
    Ok(vec![link])
}

/// An attached picture stored for the UI to show; `None` for any other
/// attachment, or when it can't be stored (it was sent to the agent anyway).
pub(super) fn shown_image(a: &Attachment) -> Option<UserImage> {
    use base64::Engine;
    if !a.mime.starts_with("image/") {
        return None;
    }
    let bytes = match (&a.data, &a.path) {
        (Some(data), _) => base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string()),
        (None, Some(path)) => crate::chat_images::read_file(std::path::Path::new(path)),
        _ => return None,
    };
    match bytes.and_then(|bytes| crate::chat_images::store(&bytes)) {
        Ok(id) => Some(UserImage { name: a.name.clone(), mime_type: a.mime.clone(), id }),
        Err(e) => {
            eprintln!("could not keep {} for display: {e}", a.name);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn staging_tracks_quota_and_unstage_frees_it() {
        // A private base of our own: the root is created 0700 by `stage_in` (temp itself belongs to root on unix).
        let base = std::env::temp_dir().join(format!("flowcode-att-test-{}", uuid::Uuid::new_v4()));
        crate::chat_images::create_private_dir(&base).unwrap();
        let root = base.join("attachments");
        let age = std::time::Duration::from_secs(3 * 24 * 60 * 60);
        let mut total = None;
        let (id, file) = super::stage_in(&root, &mut total, age, "a.txt", b"hello").unwrap();
        assert!(file.is_file());
        assert_eq!(total, Some(5));
        assert!(super::unstage_in(&root, &mut total, "not-a-uuid").is_err());
        assert!(super::unstage_in(&root, &mut total, &format!("../{id}")).is_err());
        super::unstage_in(&root, &mut total, &id).unwrap();
        assert_eq!(total, Some(0));
        assert!(!file.exists());
        super::unstage_in(&root, &mut total, &uuid::Uuid::new_v4().to_string()).unwrap();
        assert_eq!(total, Some(0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_uploads_are_purged_before_refusing() {
        // A private base of our own: the root is created 0700 by `stage_in` (temp itself belongs to root on unix).
        let base = std::env::temp_dir().join(format!("flowcode-att-test-{}", uuid::Uuid::new_v4()));
        crate::chat_images::create_private_dir(&base).unwrap();
        let root = base.join("attachments");
        let mut total = Some(super::MAX_ATTACHMENTS_TOTAL);
        let (old, _) = super::stage_in(&root, &mut Some(0), std::time::Duration::ZERO, "a.txt", b"x").unwrap();
        // The counter says full: with nothing old enough the stage is refused...
        let day = std::time::Duration::from_secs(86_400);
        assert!(super::stage_in(&root, &mut total, day, "b.txt", b"y").is_ok(), "recount shows room");
        // ...and a zero max age purges the old one on the way.
        let mut full = Some(super::MAX_ATTACHMENTS_TOTAL);
        std::thread::sleep(std::time::Duration::from_millis(20));
        super::stage_in(&root, &mut full, std::time::Duration::ZERO, "c.txt", b"z").unwrap();
        assert!(!root.join(&old).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn uploads_are_staged_and_resolved_inside_the_store() {
        let id = super::stage_upload("note.txt", b"hello").unwrap();
        let a = super::uploaded_attachment(&id, "note.txt", "text/plain").unwrap();
        let path = std::path::PathBuf::from(a.path.clone().unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert_eq!(a.mime, "text/plain");
        assert_eq!(super::uploaded_attachment(&id, "note.txt", "bad mime;x").unwrap().mime, "application/octet-stream");
        assert!(super::uploaded_attachment("not-a-uuid", "note.txt", "text/plain").is_err());
        assert!(super::uploaded_attachment(&uuid::Uuid::new_v4().to_string(), "note.txt", "text/plain").is_err());
        assert!(super::uploaded_attachment(&format!("../{id}"), "note.txt", "").is_err());
        let root = super::attachments_root();
        let evil = id_path("../../x.txt", &id);
        assert!(evil.is_none_or(|p| p.starts_with(&root)));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    fn id_path(name: &str, id: &str) -> Option<std::path::PathBuf> {
        super::uploaded_attachment(id, name, "").ok().and_then(|a| a.path).map(Into::into)
    }
}
