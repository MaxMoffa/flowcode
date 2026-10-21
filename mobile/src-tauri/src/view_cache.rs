//! Agent-view plugin files received from the desktop, cached on the phone and
//! served to the webview through the `flowcode-plugin` URI scheme. The desktop
//! sends a package in chunks (`view_cache_write`); `view_cache_commit` checks
//! it against the package hash before it becomes visible. One folder per
//! package, `views/<id>/<hash>/`. This module never runs any of it.
//!
//! Path rules, CSP and content types are copied from the desktop's
//! `src-tauri/src/view_plugins.rs`: keep them in step.

use crate::state::Remote;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State};

const MAX_FILES: usize = 500;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
/// What a package may contain - no executables, no archives.
const ALLOWED_EXTENSIONS: [&str; 19] = [
    "html", "htm", "js", "mjs", "css", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2",
    "ttf", "otf", "txt", "md",
];
/// Where packages being received wait for their commit. Starts with a dot, so
/// it can never be a view id.
const STAGING: &str = ".staging";

/// Sent with every served file. Scripts and styles may be inline or from the
/// package itself, but nothing may reach the network (`connect-src 'none'`,
/// no forms, no nested frames, no plugins): a view only ever talks to the app
/// through postMessage.
const VIEW_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; \
form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

/// Serializes the commands that change the cache: a prune must not land in the
/// middle of a commit.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn views_dir(remote: &Remote) -> PathBuf {
    remote.dir.join("views")
}

/// `^[a-z0-9][a-z0-9_-]{0,63}$`. The id becomes a folder name and a URL
/// segment, so every path built from one goes through this first.
fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// `^[0-9a-f]{64}$`: a SHA-256 in lowercase hex.
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A relative path from untrusted input, normalized to forward slashes - or
/// None if it could point anywhere but down inside its package: empty, `.` or
/// `..` segments, absolute and drive paths (`:` never appears in a segment),
/// NUL.
fn sanitize_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let ok = segments.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains([':', '\0']));
    ok.then(|| segments.join("/"))
}

fn extension_of(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

/// A file path of a package: sanitized and of an allowed type.
fn package_path(path: &str) -> Result<String, String> {
    let clean = sanitize_path(path).ok_or_else(|| format!("invalid path in the package: {path}"))?;
    if !ALLOWED_EXTENSIONS.contains(&extension_of(&clean).as_str()) {
        return Err(format!("file type not allowed: {clean}"));
    }
    Ok(clean)
}

fn check_key(id: &str, hash: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("invalid view id".into());
    }
    if !valid_hash(hash) {
        return Err("invalid package hash".into());
    }
    Ok(())
}

fn staging_dir(views: &Path, id: &str, hash: &str) -> PathBuf {
    views.join(STAGING).join(format!("{id}-{hash}"))
}

/// Number of files and bytes under `dir`, not counting the file `except`.
fn dir_usage(dir: &Path, except: &Path) -> std::io::Result<(usize, u64)> {
    let mut usage = (0, 0);
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_dir() {
                pending.push(entry.path());
            } else if entry.path() != except {
                usage = (usage.0 + 1, usage.1 + meta.len());
            }
        }
    }
    Ok(usage)
}

/// Whether the complete package is cached.
fn has(views: &Path, id: &str, hash: &str) -> Result<bool, String> {
    check_key(id, hash)?;
    Ok(views.join(id).join(hash).is_dir())
}

/// Writes one chunk of one file into the staging folder of (id, hash). A file's
/// chunks arrive in order, so `offset` is 0 (the file starts over) or the size
/// written so far.
fn write_chunk(views: &Path, id: &str, hash: &str, path: &str, offset: u64, total: u64, data: &str) -> Result<(), String> {
    check_key(id, hash)?;
    let path = package_path(path)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    let end = offset.checked_add(bytes.len() as u64).ok_or("chunk out of range")?;
    if total > MAX_FILE_BYTES || end > total {
        return Err("chunk out of range or file too large".into());
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let staging = staging_dir(views, id, hash);
    let file = staging.join(&path);
    if offset == 0 {
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let (count, used) = dir_usage(&staging, &file).map_err(|e| e.to_string())?;
        if count >= MAX_FILES || used + total > MAX_TOTAL_BYTES {
            return Err("package is too large".into());
        }
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(offset == 0)
        .truncate(offset == 0)
        .open(&file)
        .map_err(|e| e.to_string())?;
    if out.metadata().map_err(|e| e.to_string())?.len() != offset {
        return Err(format!("chunk out of order: {path}"));
    }
    out.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    out.write_all(&bytes).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct StagedFile {
    path: String,
    size: u64,
}

#[derive(Deserialize)]
pub struct Keep {
    id: String,
    hash: String,
}

/// SHA-256 as the desktop computes it: over the files in path order, each as
/// its path bytes, a NUL, its length as u64 little-endian and its bytes.
fn package_hash(root: &Path, paths: &[&str]) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    for path in paths {
        let bytes = std::fs::read(root.join(path))?;
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn check_staged(staging: &Path, hash: &str, files: &[StagedFile]) -> Result<(), String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("package is empty or has too many files".into());
    }
    let mut seen = HashSet::new();
    let mut paths = Vec::with_capacity(files.len());
    let mut total = 0;
    for file in files {
        let path = package_path(&file.path)?;
        if file.size > MAX_FILE_BYTES {
            return Err(format!("file too large: {path}"));
        }
        total += file.size;
        if total > MAX_TOTAL_BYTES {
            return Err("package is too large".into());
        }
        match std::fs::metadata(staging.join(&path)) {
            Ok(meta) if meta.is_file() && meta.len() == file.size => {}
            _ => return Err(format!("file missing or incomplete: {path}")),
        }
        if !seen.insert(path.clone()) {
            return Err(format!("duplicate file: {path}"));
        }
        paths.push(path);
    }
    // Leftovers of an abandoned transfer would otherwise end up in the cache.
    let (count, _) = dir_usage(staging, Path::new("")).map_err(|e| e.to_string())?;
    if count != files.len() {
        return Err("unexpected files in the staged package".into());
    }
    paths.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    if package_hash(staging, &paths).map_err(|e| e.to_string())? != hash {
        return Err("package hash mismatch".into());
    }
    Ok(())
}

/// Verifies the staged package and swaps it in as `views/<id>/<hash>/`, then
/// drops the other versions of the view. A failed check clears the staging.
fn commit(views: &Path, id: &str, hash: &str, files: &[StagedFile]) -> Result<(), String> {
    check_key(id, hash)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let staging = staging_dir(views, id, hash);
    if let Err(e) = check_staged(&staging, hash, files) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let folder = views.join(id);
    let target = folder.join(hash);
    let moved = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&folder)?;
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&staging, &target)
    })();
    if let Err(e) = moved {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }
    // Best effort: an old version left behind is only wasted space.
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            if entry.file_name().to_str() != Some(hash) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

/// Deletes every cached view and hash not in `keep`. Staging is left alone: a
/// transfer may be running.
fn prune(views: &Path, keep: &[Keep]) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let keep: HashSet<(&str, &str)> = keep.iter().map(|k| (k.id.as_str(), k.hash.as_str())).collect();
    let entries = match std::fs::read_dir(views) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if id == STAGING {
            continue;
        }
        if !valid_id(&id) || !entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
            continue;
        }
        for version in std::fs::read_dir(entry.path()).map_err(|e| e.to_string())?.flatten() {
            let hash = version.file_name().to_string_lossy().into_owned();
            if !keep.contains(&(id.as_str(), hash.as_str())) {
                let _ = std::fs::remove_dir_all(version.path());
            }
        }
        // Removes the view's folder once empty; fails (ignored) otherwise.
        let _ = std::fs::remove_dir(entry.path());
    }
    Ok(())
}

// `(async)`: file work, kept off the main thread.
#[tauri::command(async)]
pub fn view_cache_has(remote: State<'_, Arc<Remote>>, id: String, hash: String) -> Result<bool, String> {
    has(&views_dir(&remote), &id, &hash)
}

#[tauri::command(async)]
pub fn view_cache_write(
    remote: State<'_, Arc<Remote>>,
    id: String,
    hash: String,
    path: String,
    offset: u64,
    total: u64,
    data: String,
) -> Result<(), String> {
    write_chunk(&views_dir(&remote), &id, &hash, &path, offset, total, &data)
}

#[tauri::command(async)]
pub fn view_cache_commit(remote: State<'_, Arc<Remote>>, id: String, hash: String, files: Vec<StagedFile>) -> Result<(), String> {
    commit(&views_dir(&remote), &id, &hash, &files)
}

#[tauri::command(async)]
pub fn view_cache_prune(remote: State<'_, Arc<Remote>>, keep: Vec<Keep>) -> Result<(), String> {
    prune(&views_dir(&remote), &keep)
}

/// Percent-decodes a URL path (`%2F` included, so a path whose slashes were
/// encoded splits all the same). None on bad escapes or non-UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A request path (`/<id>/<hash>/<file>`) split into the view id, the
/// package hash and the sanitized file path inside it.
fn split_request_path(uri_path: &str) -> Option<(String, String, String)> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'))?;
    let mut parts = decoded.splitn(3, '/');
    let (id, hash, rest) = (parts.next()?, parts.next()?, parts.next()?);
    if !valid_id(id) || !valid_hash(hash) {
        return None;
    }
    Some((id.to_string(), hash.to_string(), sanitize_path(rest)?))
}

fn content_type(path: &str) -> &'static str {
    match extension_of(path).as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", VIEW_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .unwrap_or_default()
}

/// The file a request asks for, if it exists inside its package's folder.
/// Canonicalized and re-checked against the folder, so a symlink inside a
/// package can't lead out of it.
fn resolve_file(views: &Path, id: &str, hash: &str, rel: &str) -> Option<PathBuf> {
    let root = views.join(id).join(hash).canonicalize().ok()?;
    let file = root.join(rel).canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

/// Handler of the `flowcode-plugin` URI scheme. The webview builds URLs with
/// `pluginFileUrl(convertFileSrc("<id>", "flowcode-plugin"), "<hash>/<entry>")`,
/// which is `http://flowcode-plugin.localhost/<id>/<hash>/<entry>` on Android,
/// so the page's relative files resolve next to it.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return respond(StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new());
    }
    let served = split_request_path(request.uri().path()).and_then(|(id, hash, rel)| {
        let views = views_dir(app.try_state::<Arc<Remote>>()?.inner());
        let file = resolve_file(&views, &id, &hash, &rel)?;
        Some((content_type(&rel), std::fs::read(file).ok()?))
    });
    match served {
        Some((kind, body)) => respond(StatusCode::OK, kind, body),
        None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "timeline";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fcm-views-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Hash of a package the way the desktop computes it (independent of `package_hash`).
    fn hash_of(files: &[(&str, &[u8])]) -> String {
        let mut sorted = files.to_vec();
        sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut hasher = Sha256::new();
        for (path, bytes) in sorted {
            hasher.update(path.as_bytes());
            hasher.update([0u8]);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn send(views: &Path, hash: &str, files: &[(&str, &[u8])]) {
        for (path, bytes) in files {
            let total = bytes.len() as u64;
            let mut offset = 0;
            // Two-byte chunks, so every file spans several.
            for chunk in bytes.chunks(2) {
                write_chunk(views, ID, hash, path, offset, total, &b64(chunk)).unwrap();
                offset += chunk.len() as u64;
            }
        }
    }

    fn list(files: &[(&str, &[u8])]) -> Vec<StagedFile> {
        files.iter().map(|(p, b)| StagedFile { path: p.to_string(), size: b.len() as u64 }).collect()
    }

    const PACKAGE: [(&str, &[u8]); 3] = [("index.html", b"<p>hi</p>"), ("js/app.js", b"run()"), ("a.css", b"b{}")];

    #[test]
    fn chunks_then_commit_caches_the_package() {
        let views = temp("commit");
        let hash = hash_of(&PACKAGE);
        assert!(!has(&views, ID, &hash).unwrap());
        send(&views, &hash, &PACKAGE);
        commit(&views, ID, &hash, &list(&PACKAGE)).unwrap();
        assert!(has(&views, ID, &hash).unwrap());
        let file = resolve_file(&views, ID, &hash, "js/app.js").unwrap();
        assert_eq!(std::fs::read(file).unwrap(), b"run()");
        assert!(!staging_dir(&views, ID, &hash).exists());
        // A newer version replaces the older one.
        let next: [(&str, &[u8]); 1] = [("index.html", b"v2")];
        let next_hash = hash_of(&next);
        send(&views, &next_hash, &next);
        commit(&views, ID, &next_hash, &list(&next)).unwrap();
        assert!(has(&views, ID, &next_hash).unwrap());
        assert!(!has(&views, ID, &hash).unwrap());
        let _ = std::fs::remove_dir_all(views);
    }

    #[test]
    fn tampered_or_incomplete_packages_are_rejected_and_cleared() {
        let views = temp("tamper");
        let hash = hash_of(&PACKAGE);
        let tampered: [(&str, &[u8]); 3] = [("index.html", b"<p>ho</p>"), PACKAGE[1], PACKAGE[2]];
        send(&views, &hash, &tampered);
        assert!(commit(&views, ID, &hash, &list(&tampered)).unwrap_err().contains("hash mismatch"));
        assert!(!has(&views, ID, &hash).unwrap());
        assert!(!staging_dir(&views, ID, &hash).exists());

        // A file missing from what was sent.
        send(&views, &hash, &PACKAGE[..2]);
        assert!(commit(&views, ID, &hash, &list(&PACKAGE)).is_err());
        assert!(!has(&views, ID, &hash).unwrap());
        assert!(!staging_dir(&views, ID, &hash).exists());
        let _ = std::fs::remove_dir_all(views);
    }

    #[test]
    fn rejects_bad_chunks() {
        let views = temp("chunks");
        let hash = hash_of(&PACKAGE);
        let write = |offset, total, data: &[u8], path| write_chunk(&views, ID, &hash, path, offset, total, &b64(data));
        assert!(write(0, 4, b"abc", "a.js").is_ok());
        // Out of order, past the declared size, too large, bad base64, bad paths.
        assert!(write(2, 4, b"x", "a.js").is_err());
        assert!(write(3, 4, b"xy", "a.js").is_err());
        assert!(write(0, MAX_FILE_BYTES + 1, b"x", "b.js").is_err());
        assert!(write_chunk(&views, ID, &hash, "c.js", 0, 4, "***").is_err());
        assert!(write(0, 1, b"x", "bad.exe").is_err());
        assert!(write(0, 1, b"x", "../x.js").is_err());
        let _ = std::fs::remove_dir_all(views);
    }

    #[test]
    fn limits_files_and_total_size() {
        let views = temp("limits");
        let hash = hash_of(&PACKAGE);
        for i in 0..MAX_FILES {
            write_chunk(&views, ID, &hash, &format!("f{i}.txt"), 0, 1, &b64(b"x")).unwrap();
        }
        assert!(write_chunk(&views, ID, &hash, "extra.txt", 0, 1, &b64(b"x")).is_err());
        let _ = std::fs::remove_dir_all(&views);

        // Announced sizes count, but only written bytes are on disk: fill for real.
        let big = vec![0u8; MAX_FILE_BYTES as usize];
        for i in 0..4 {
            write_chunk(&views, ID, &hash, &format!("big{i}.txt"), 0, MAX_FILE_BYTES, &b64(&big)).unwrap();
        }
        assert!(write_chunk(&views, ID, &hash, "big4.txt", 0, MAX_FILE_BYTES, &b64(&big)).is_err());
        let _ = std::fs::remove_dir_all(views);
    }

    #[test]
    fn prune_keeps_only_the_listed_versions() {
        let views = temp("prune");
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        for (id, hash) in [("one", &a), ("one", &b), ("two", &a)] {
            std::fs::create_dir_all(views.join(id).join(hash)).unwrap();
        }
        prune(&views, &[Keep { id: "one".into(), hash: a.clone() }]).unwrap();
        assert!(has(&views, "one", &a).unwrap());
        assert!(!has(&views, "one", &b).unwrap());
        assert!(!views.join("two").exists());
        let _ = std::fs::remove_dir_all(views);
    }

    #[test]
    fn validates_ids_hashes_and_paths() {
        assert!(valid_id("timeline") && valid_id("a_b-9") && valid_id(&"a".repeat(64)));
        for bad in ["", "-a", "_a", "A", "a b", "a.b", ".staging", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(valid_hash(&"0f".repeat(32)));
        for bad in ["", &"0".repeat(63), &"0".repeat(65), &"A".repeat(64), &"g".repeat(64)] {
            assert!(!valid_hash(bad), "{bad:?}");
        }
        assert_eq!(sanitize_path("a\\b.js").as_deref(), Some("a/b.js"));
        for bad in ["../x", "a/../../x", "C:\\x", "/x", "a//b", "a/./b", "", "a/b\0c"] {
            assert!(sanitize_path(bad).is_none(), "{bad:?}");
        }
        assert!(package_path("x.exe").is_err() && package_path("x").is_err());
        assert_eq!(package_path("A/B.HTML").unwrap(), "A/B.HTML");
    }

    #[test]
    fn splits_request_paths() {
        let hash = "ab".repeat(32);
        assert_eq!(
            split_request_path(&format!("/timeline%2F{hash}%2Findex.html")),
            Some(("timeline".to_string(), hash.clone(), "index.html".to_string()))
        );
        assert_eq!(
            split_request_path(&format!("/timeline/{hash}/js/app%20x.js")),
            Some(("timeline".to_string(), hash.clone(), "js/app x.js".to_string()))
        );
        assert!(split_request_path(&format!("/timeline%2F{hash}%2F..%2F..%2Fx")).is_none());
        assert!(split_request_path(&format!("/Bad%2F{hash}%2Findex.html")).is_none());
        assert!(split_request_path("/timeline%2Fnothash%2Findex.html").is_none());
        assert!(split_request_path(&format!("/timeline%2F{hash}")).is_none());
        assert!(split_request_path("/timeline%2F%zz").is_none());
    }

    #[test]
    fn resolve_file_stays_inside_the_package() {
        let views = temp("resolve");
        let hash = "c".repeat(64);
        let root = views.join(ID).join(&hash);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "x").unwrap();
        std::fs::write(views.join(ID).join("secret.txt"), "s").unwrap();
        assert!(resolve_file(&views, ID, &hash, "index.html").is_some());
        assert!(resolve_file(&views, ID, &hash, "../secret.txt").is_none());
        assert!(resolve_file(&views, ID, &hash, "missing.html").is_none());
        let _ = std::fs::remove_dir_all(views);
    }
}
