//! Images of a chat, kept on disk instead of in the event log.
//!
//! An agent sends pictures as base64 inside its updates (tool results,
//! replayed history), and a user attaches some. Left in the log they would eat
//! its byte budget and overflow the phones' 1 MiB frames, so each is written
//! once to a content-addressed file and the event carries its id instead
//! (`flowcodeImageId`); the UI fetches the bytes on demand. Pictures an agent
//! only mentions by path (markdown `![](path)`) are read from where they are,
//! see `resolve_file`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Largest image file read from disk, bytes.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Stored images older than this are deleted at startup.
const MAX_AGE: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// Extensions served as images (lowercase).
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];

/// Where stored images live. Temporary on purpose: replayed history stores
/// them again.
fn dir() -> PathBuf {
    std::env::temp_dir().join("flowcode-chat-images")
}

/// Writes `bytes` to the store (nothing if they are there already) and returns
/// their id: the lowercase hex SHA-256. The file appears whole or not at all.
pub(crate) fn store(bytes: &[u8]) -> Result<String, String> {
    use std::fmt::Write;
    let mut id = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        let _ = write!(id, "{b:02x}");
    }
    let dir = dir();
    let target = dir.join(&id);
    if target.exists() {
        return Ok(id);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let temp = dir.join(format!(".{id}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        // Another thread storing the same picture may have got there first.
        if !target.exists() {
            return Err(format!("could not save {}: {e}", target.display()));
        }
    }
    Ok(id)
}

/// Replaces the base64 `data` of every ACP `image` block inside `value` with a
/// `flowcodeImageId` (the block keeps its `mimeType`, `uri`, ...). An image
/// that can't be decoded or saved just loses its data.
pub(crate) fn stash_images(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(stash_images),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") && map.get("data").is_some_and(Value::is_string) {
                if let Some(Value::String(data)) = map.remove("data") {
                    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
                    let stored = base64::engine::general_purpose::STANDARD
                        .decode(clean)
                        .map_err(|e| format!("bad base64: {e}"))
                        .and_then(|bytes| store(&bytes));
                    match stored {
                        Ok(id) => {
                            map.insert("flowcodeImageId".into(), Value::String(id));
                        }
                        Err(e) => eprintln!("chat image dropped: {e}"),
                    }
                }
            } else {
                map.values_mut().for_each(stash_images);
            }
        }
        _ => {}
    }
}

/// Whether `id` has the shape of a stored image's: 64 lowercase hex digits
/// (so it can never name another path).
pub(crate) fn is_image_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The file of a stored image, if the id is valid and the file exists.
pub(crate) fn path_of(id: &str) -> Option<PathBuf> {
    if !is_image_id(id) {
        return None;
    }
    Some(dir().join(id)).filter(|p| p.is_file())
}

/// The bytes of a stored image.
pub(crate) fn read(id: &str) -> Result<Vec<u8>, String> {
    let path = path_of(id).ok_or_else(|| "missing".to_string())?;
    std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Decodes `%XX` escapes (invalid ones stay as they are).
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A Linux path as Windows sees it: `/mnt/c/a` -> `C:\a`, anything else lives
/// in the distro (`\\wsl.localhost\<distro>\...`). `distro` empty: unknown.
fn from_wsl_path(posix: &str, distro: &str) -> Result<String, String> {
    if let Some(rest) = posix.strip_prefix("/mnt/") {
        let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
        if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
            return Ok(format!("{}:\\{}", drive.to_ascii_uppercase(), tail.replace('/', "\\")));
        }
    }
    if distro.is_empty() {
        return Err("unknown WSL distro".into());
    }
    Ok(format!("\\\\wsl.localhost\\{distro}{}", posix.replace('/', "\\")))
}

/// Whether `path` is already a Windows path (drive or UNC).
fn is_windows_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with("\\\\") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// The file an image reference of a chat points at. `path` is a plain path or
/// a `file://` URL; a relative one is joined to the chat's `cwd`. For a chat
/// running in WSL (`wsl_distro` is `Some`; `""` when the distro is unknown)
/// the paths are Linux ones and are mapped to what Windows can open.
pub(crate) fn resolve_file(path: &str, cwd: Option<&str>, wsl_distro: Option<&str>) -> Result<PathBuf, String> {
    let mut path = match path.strip_prefix("file://") {
        Some(url) => {
            let decoded = percent_decode(url);
            let b = decoded.as_bytes();
            // `file:///C:/x`: the slash before the drive is not part of the path.
            if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
                decoded[1..].to_string()
            } else {
                decoded
            }
        }
        None => path.to_string(),
    };
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| EXTENSIONS.contains(&e.as_str())) {
        return Err("not an image".into());
    }
    let distro = wsl_distro.unwrap_or("");
    let linux = |p: &str| wsl_distro.is_some() && p.starts_with('/');
    if linux(&path) {
        path = from_wsl_path(&path, distro)?;
    } else if !is_windows_absolute(&path) && !path.starts_with('/') {
        let cwd = cwd.ok_or_else(|| "relative path without a folder".to_string())?;
        let base = if linux(cwd) { from_wsl_path(cwd, distro)? } else { cwd.to_string() };
        path = format!("{}\\{}", base.trim_end_matches(['\\', '/']), path.replace('/', "\\"));
    }
    Ok(PathBuf::from(path))
}

/// The bytes of an image file; not directories, not files over 32 MiB.
pub(crate) fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("image too large".into());
    }
    std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// The MIME type an image file's extension stands for.
pub(crate) fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Deletes the stored images not touched for three days. Run once at startup.
pub(crate) fn purge_old() {
    let Ok(entries) = std::fs::read_dir(dir()) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > MAX_AGE);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn stash_replaces_data_with_an_id_and_writes_the_file() {
        let bytes = [1u8, 2, 3, 250, 251, 7, 7, 42];
        let mut v = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "mimeType": "image/png", "data": b64(&bytes), "uri": "x" } });
        stash_images(&mut v);
        let content = &v["content"];
        assert!(content.get("data").is_none());
        assert_eq!((content["mimeType"].as_str(), content["uri"].as_str()), (Some("image/png"), Some("x")));
        let id = content["flowcodeImageId"].as_str().unwrap();
        assert!(is_image_id(id));
        assert_eq!(read(id).unwrap(), bytes);
        assert!(path_of(id).is_some());
    }

    #[test]
    fn nested_tool_content_is_stashed_and_whitespace_tolerated() {
        let bytes = [9u8, 8, 7, 6, 5, 4, 3, 2, 1, 99];
        let encoded = b64(&bytes);
        let spaced = format!("{}\n{}", &encoded[..4], &encoded[4..]);
        let mut v = json!({ "sessionUpdate": "tool_call_update", "content": [{ "type": "content", "content": { "type": "image", "mimeType": "image/jpeg", "data": spaced } }] });
        stash_images(&mut v);
        let id = v["content"][0]["content"]["flowcodeImageId"].as_str().unwrap().to_string();
        assert_eq!(read(&id).unwrap(), bytes);
    }

    #[test]
    fn invalid_base64_drops_the_data_without_an_id() {
        let mut v = json!({ "type": "image", "mimeType": "image/png", "data": "***not base64***" });
        stash_images(&mut v);
        assert_eq!(v, json!({ "type": "image", "mimeType": "image/png" }));
    }

    #[test]
    fn values_without_images_are_untouched() {
        let original = json!({ "a": [1, "x", { "type": "text", "data": "abc" }], "type": "image", "uri": "u" });
        let mut v = original.clone();
        stash_images(&mut v);
        assert_eq!(v, original);
    }

    #[test]
    fn image_ids_are_64_lowercase_hex() {
        assert!(is_image_id(&"a0".repeat(32)));
        assert!(!is_image_id(&"A0".repeat(32)));
        assert!(!is_image_id(&"a0".repeat(31)));
        assert!(!is_image_id(&format!("{}..", "a".repeat(62))));
        assert!(path_of("../x").is_none());
    }

    #[test]
    fn file_references_resolve_to_windows_paths() {
        let p = |path: &str, cwd: Option<&str>, wsl: Option<&str>| resolve_file(path, cwd, wsl).map(|p| p.to_string_lossy().into_owned());
        assert_eq!(p("/mnt/c/x.png", None, Some("Ubuntu")).unwrap(), r"C:\x.png");
        assert_eq!(p("/home/me/a/B.PNG", None, Some("Ubuntu")).unwrap(), r"\\wsl.localhost\Ubuntu\home\me\a\B.PNG");
        assert!(p("/home/me/a.png", None, Some("")).is_err());
        assert_eq!(p("/mnt/d/a/b.jpg", None, Some("")).unwrap(), r"D:\a\b.jpg");
        assert_eq!(p("shots/a.png", Some(r"C:\proj"), None).unwrap(), r"C:\proj\shots\a.png");
        assert_eq!(p("a.png", Some("/home/me"), Some("Debian")).unwrap(), r"\\wsl.localhost\Debian\home\me\a.png");
        assert!(p("a.png", None, None).is_err());
        assert_eq!(p(r"C:\a\b.gif", None, None).unwrap(), r"C:\a\b.gif");
        assert_eq!(p("file:///C:/my%20dir/x.webp", None, None).unwrap(), "C:/my dir/x.webp");
        assert_eq!(p("file:///mnt/c/x.png", None, Some("Ubuntu")).unwrap(), r"C:\x.png");
        assert_eq!(p("notes.txt", Some(r"C:\proj"), None), Err("not an image".into()));
    }

    #[test]
    fn mime_follows_the_extension() {
        assert_eq!(mime_of(Path::new("a.SVG")), "image/svg+xml");
        assert_eq!(mime_of(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(mime_of(Path::new("a.ico")), "image/x-icon");
    }
}
