//! The standalone explorer of an authenticated phone. The legacy tab-rooted
//! browser keeps its original sandbox in fsbrowse.rs.
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use flowcode_remote_proto::{FsHit, FsRequest, FsResponse, FsRoot, LsEntry, MAX_FRAME};
use flowcode_shared::i18n::tr;
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

fn shown(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/UNC/") { format!("//{rest}") }
    else { text.strip_prefix("//?/").unwrap_or(&text).to_string() }
}

/// Never probe network shares or device namespaces supplied by a phone.
fn resolve(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.len() > 4096 || !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir))
        || !crate::fs::is_local_path(path, false) || !crate::fs::links_stay_local(path) {
        return Err(tr("Percorso locale non valido", "Invalid local path").into());
    }
    let full = path.canonicalize().map_err(|e| e.to_string())?;
    if !crate::fs::is_local_path(&full, true) { return Err("Invalid local path".into()); }
    Ok(full)
}

fn name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', ':', '\0']) {
        Err(tr("Nome non valido", "Invalid name").into())
    } else { Ok(value) }
}

fn mutable(path: &str, config: Option<&Path>) -> Result<PathBuf, String> {
    let full = resolve(path)?;
    let protected = full.parent().is_none()
        || crate::fs::user_home().and_then(|p| p.canonicalize().ok()).is_some_and(|p| p.starts_with(&full))
        || config.and_then(|p| p.canonicalize().ok()).is_some_and(|p| p.starts_with(&full));
    // Mutations must not silently act on the target of a link.
    if protected || std::fs::symlink_metadata(path).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err(tr("Questa posizione non può essere modificata", "This location cannot be changed").into());
    }
    Ok(full)
}

/// Windows' hidden attribute, read without following links.
#[cfg(windows)]
fn hidden(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    entry.metadata().is_ok_and(|m| m.file_attributes() & 0x2 != 0)
}
#[cfg(not(windows))]
fn hidden(_: &std::fs::DirEntry) -> bool { false }

pub(super) fn roots() -> FsResponse {
    let mut roots = Vec::new();
    if let Some(home) = crate::fs::user_home() {
        roots.push(FsRoot { name: tr("Cartella utente", "Home folder").into(), path: shown(&home) });
    }
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let path = format!("{}:/", letter as char);
            if Path::new(&path).is_dir() { roots.push(FsRoot { name: path.clone(), path }); }
        }
        if crate::util::wsl_running() {
            if let Ok(distros) = std::fs::read_dir(r"\\wsl.localhost\") {
                for distro in distros.flatten().take(32) {
                    roots.push(FsRoot { name: format!("WSL · {}", distro.file_name().to_string_lossy()), path: shown(&distro.path()) });
                }
            }
        }
    }
    #[cfg(not(windows))]
    roots.push(FsRoot { name: tr("File system", "Filesystem").into(), path: "/".into() });
    FsResponse::Roots { roots }
}

fn version(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn read(path: &Path) -> Result<FsResponse, String> {
    if !path.is_file() { return Err(tr("Non è un file", "Not a file").into()); }
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|e| e.to_string())?.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(tr("File binario: non si può mostrare", "Binary file: cannot be shown").into());
    }
    let mut truncated = bytes.len() > MAX_BYTES;
    bytes.truncate(MAX_BYTES);
    if truncated {
        if let Err(e) = std::str::from_utf8(&bytes) {
            if e.error_len().is_none() { bytes.truncate(e.valid_up_to()); }
        }
    }
    let text = String::from_utf8(bytes.clone()).map_err(|_| tr("Codifica non supportata: serve UTF-8", "Unsupported encoding: UTF-8 required").to_string())?;
    let mut response = FsResponse::File { path: shown(path), text, truncated, version: (!truncated).then(|| version(&bytes)) };
    // Include JSON escaping and the response envelope in the frame budget.
    loop {
        if serde_json::to_vec(&response).map_err(|e| e.to_string())?.len() < MAX_FRAME - 8192 { return Ok(response); }
        if let FsResponse::File { text, truncated: flag, version, .. } = &mut response {
            let mut cut = text.len() / 4 * 3;
            while !text.is_char_boundary(cut) { cut -= 1; }
            text.truncate(cut); truncated = true; *flag = truncated; *version = None;
        }
    }
}

const SEARCH_QUERY_MAX: usize = 256;
const SEARCH_DEPTH_MAX: u32 = 32;
/// Hands out the generations of the host's searches: one per request, in arrival order.
static SEARCH_SEQ: AtomicU64 = AtomicU64::new(1);

/// The counter one connection's searches are cancelled by: a newer search of the same kind (folders only / all names)
/// from the same connection stops an older one, so the explorer's and the new tab's searches don't cancel each other.
fn search_label(conn: u64, dirs_only: bool) -> String {
    format!("remote-{conn}|{}", if dirs_only { "dirs" } else { "all" })
}

/// Every counter a connection may have made (for its cleanup).
pub(super) fn search_labels(conn: u64) -> [String; 2] {
    [search_label(conn, true), search_label(conn, false)]
}

/// Claims the next generation of `conn`'s search of that kind; call it in the order requests arrive, before the walk runs on the pool.
pub(super) fn begin_search(conn: u64, dirs_only: bool) -> (String, u64) {
    let label = search_label(conn, dirs_only);
    let generation = SEARCH_SEQ.fetch_add(1, Ordering::Relaxed);
    crate::fs::note_search_generation(&label, generation);
    (label, generation)
}

fn search(path: &str, query: &str, dirs_only: bool, max_depth: Option<u32>, show_hidden: bool, slot: (String, u64)) -> Result<FsResponse, String> {
    if query.len() > SEARCH_QUERY_MAX {
        return Err(tr("Ricerca troppo lunga", "Search too long").into());
    }
    let root = resolve(path)?;
    let (label, generation) = slot;
    let depth = max_depth.map(|d| d.clamp(1, SEARCH_DEPTH_MAX));
    let entries = crate::fs::search_entries(&shown(&root), query, show_hidden, dirs_only, depth, label, generation)
        .into_iter()
        .map(|e| FsHit { name: e.name, path: shown(Path::new(&e.path)), dir: e.is_dir })
        .collect();
    Ok(FsResponse::Search { entries })
}

pub(super) fn run(request: FsRequest, config: Option<&Path>) -> Result<FsResponse, String> {
    run_for(request, config, None)
}

/// `run`, with the claimed generation for a `Search` (`begin_search`); without one the search gets a counter of its own.
pub(super) fn run_for(request: FsRequest, config: Option<&Path>, slot: Option<(String, u64)>) -> Result<FsResponse, String> {
    match request {
        FsRequest::Search { path, query, dirs_only, max_depth, show_hidden } => {
            let slot = slot.unwrap_or_else(|| begin_search(0, dirs_only));
            search(&path, &query, dirs_only, max_depth, show_hidden, slot)
        }
        FsRequest::Duplicate { path } => {
            let source = mutable(&path, config)?;
            let copy = crate::fs::duplicate_blocking(&shown(&source))?;
            Ok(FsResponse::Done { path: shown(Path::new(&copy.path)) })
        }
        FsRequest::Info { path } => {
            let info = crate::fs::get_file_info(shown(&resolve(&path)?))?;
            Ok(FsResponse::Info { info: serde_json::to_value(info).map_err(|e| e.to_string())? })
        }
        FsRequest::Roots => Ok(roots()),
        FsRequest::List { path } => {
            let dir = resolve(&path)?;
            let mut entries = Vec::new();
            let mut truncated = false;
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.take(MAX_ENTRIES + 1) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entries.len() == MAX_ENTRIES { truncated = true; break; }
                // Do not follow arbitrary UNC symlinks while listing a directory.
                let meta = if crate::fs::links_stay_local(&entry.path()) { std::fs::metadata(entry.path()).ok() } else { None };
                entries.push(LsEntry { name: entry.file_name().to_string_lossy().into_owned(), dir: meta.as_ref().is_some_and(|m| m.is_dir()), size: meta.filter(|m| m.is_file()).map(|m| m.len()), hidden: hidden(&entry) });
            }
            entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
            // WSL share roots can report a server-only parent; it is not a directory.
            let parent = dir.parent().filter(|p| p.is_absolute() && crate::fs::is_local_path(p, true)).map(shown);
            Ok(FsResponse::List { path: shown(&dir), parent, entries, truncated })
        }
        FsRequest::Read { path } => read(&resolve(&path)?),
        FsRequest::Create { path, name: value, dir } => {
            let parent = resolve(&path)?;
            let value = name(&value)?.to_string();
            if dir { crate::fs::create_dir_entry(shown(&parent), value.clone())?; }
            else { crate::fs::create_file_entry(shown(&parent), value.clone())?; }
            Ok(FsResponse::Done { path: shown(&parent.join(value)) })
        }
        FsRequest::Rename { path, name: value } => {
            let source = mutable(&path, config)?;
            let value = name(&value)?.to_string();
            crate::fs::rename_entry(shown(&source), value.clone())?;
            Ok(FsResponse::Done { path: shown(&source.parent().ok_or("Missing parent")?.join(value)) })
        }
        FsRequest::Move { path, destination } => {
            let source = mutable(&path, config)?;
            let parent = resolve(&destination)?;
            let target = parent.join(source.file_name().ok_or("Missing file name")?);
            if !parent.is_dir() || parent.starts_with(&source) || std::fs::symlink_metadata(&target).is_ok() {
                return Err(tr("Destinazione non valida o nome già esistente", "Invalid destination or name already exists").into());
            }
            std::fs::rename(source, &target).map_err(|e| e.to_string())?;
            Ok(FsResponse::Done { path: shown(&target) })
        }
        FsRequest::Delete { path } => {
            let source = mutable(&path, config)?;
            // The UI explicitly confirms permanent deletion, like the desktop explorer.
            if source.is_dir() { std::fs::remove_dir_all(&source) } else { std::fs::remove_file(&source) }.map_err(|e| e.to_string())?;
            Ok(FsResponse::Done { path: shown(&source) })
        }
        FsRequest::Write { path, text, version: expected } => {
            let path = mutable(&path, config)?;
            if text.len() > MAX_BYTES { return Err(tr("File troppo grande", "File too large").into()); }
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|e| e.to_string())?.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_BYTES || version(&bytes) != expected {
                return Err(tr("Il file è cambiato sul computer. Riaprilo prima di salvare.", "The file changed on the computer. Reopen it before saving.").into());
            }
            crate::fs::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())?;
            Ok(FsResponse::Done { path: shown(&path) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::scratch;

    #[test]
    fn explorer_works_without_terminals_and_preserves_conflicting_edits() {
        let root = scratch("explorer");
        let p = shown(&root);
        run(FsRequest::Create { path: p.clone(), name: "nested".into(), dir: true }, None).unwrap();
        run(FsRequest::Create { path: p.clone(), name: "note.txt".into(), dir: false }, None).unwrap();
        let file = shown(&root.join("note.txt"));
        let FsResponse::File { version: Some(v), truncated: false, .. } = run(FsRequest::Read { path: file.clone() }, None).unwrap() else { panic!() };
        std::fs::write(root.join("note.txt"), "desktop edit").unwrap();
        assert!(run(FsRequest::Write { path: file.clone(), text: "phone edit".into(), version: v }, None).is_err());
        assert_eq!(std::fs::read_to_string(root.join("note.txt")).unwrap(), "desktop edit");
        let FsResponse::File { version: Some(current), .. } = run(FsRequest::Read { path: file.clone() }, None).unwrap() else { panic!() };
        run(FsRequest::Write { path: file.clone(), text: "phone edit: é".into(), version: current }, None).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("note.txt")).unwrap(), "phone edit: é");
        assert!(run(FsRequest::Create { path: p.clone(), name: "../escape".into(), dir: false }, None).is_err());
        assert!(run(FsRequest::Create { path: p.clone(), name: "note.txt".into(), dir: false }, None).is_err());
        let renamed = run(FsRequest::Rename { path: file, name: "renamed.txt".into() }, None).unwrap();
        let FsResponse::Done { path } = renamed else { panic!() };
        run(FsRequest::Move { path, destination: shown(&root.join("nested")) }, None).unwrap();
        assert!(root.join("nested/renamed.txt").is_file());
        assert!(run(FsRequest::Move { path: shown(&root.join("nested")), destination: shown(&root.join("nested")) }, None).is_err());
        run(FsRequest::Delete { path: shown(&root.join("nested/renamed.txt")) }, None).unwrap();
        assert!(!root.join("nested/renamed.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_duplicate_and_info_work_on_the_host() {
        let root = scratch("explorer-extra");
        std::fs::create_dir_all(root.join("app-dir/deep")).unwrap();
        std::fs::write(root.join("app.txt"), "hello").unwrap();
        let search = |query: &str, dirs_only: bool, max_depth: Option<u32>| {
            let slot = begin_search(777, dirs_only);
            let FsResponse::Search { entries } = run_for(FsRequest::Search { path: shown(&root), query: query.into(), dirs_only, max_depth, show_hidden: false }, None, Some(slot)).unwrap() else { panic!() };
            entries
        };
        let all: Vec<_> = search("app", false, None).into_iter().map(|h| (h.name, h.dir)).collect();
        assert_eq!(all, [("app-dir".to_string(), true), ("app.txt".to_string(), false)]);
        let dirs = search("DEEP", true, Some(1));
        assert!(dirs.is_empty(), "depth 1 reads only the root's children");
        assert_eq!(search("deep", true, Some(2)).len(), 1);
        assert!(search("deep", true, None)[0].path.ends_with("app-dir/deep"));
        assert!(run(FsRequest::Search { path: shown(&root), query: "x".repeat(SEARCH_QUERY_MAX + 1), dirs_only: false, max_depth: None, show_hidden: false }, None).is_err());
        assert!(run(FsRequest::Search { path: "relative".into(), query: "a".into(), dirs_only: false, max_depth: None, show_hidden: false }, None).is_err());

        // A newer search of the same connection and kind stops an older walk; another kind is left alone.
        let older = begin_search(778, false);
        let _newer = begin_search(778, false);
        let FsResponse::Search { entries } = run_for(FsRequest::Search { path: shown(&root), query: "app".into(), dirs_only: false, max_depth: None, show_hidden: false }, None, Some(older)).unwrap() else { panic!() };
        assert!(entries.is_empty());
        let other_kind = begin_search(778, true);
        let FsResponse::Search { entries } = run_for(FsRequest::Search { path: shown(&root), query: "app".into(), dirs_only: true, max_depth: None, show_hidden: false }, None, Some(other_kind)).unwrap() else { panic!() };
        assert_eq!(entries.len(), 1);

        let FsResponse::Done { path } = run(FsRequest::Duplicate { path: shown(&root.join("app.txt")) }, None).unwrap() else { panic!() };
        assert!(path.ends_with("app copy.txt"), "{path}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        let FsResponse::Done { path } = run(FsRequest::Duplicate { path: shown(&root.join("app-dir")) }, None).unwrap() else { panic!() };
        assert!(Path::new(&path).join("deep").is_dir());
        assert!(run(FsRequest::Duplicate { path: shown(&root) }, Some(&root)).is_err(), "the config folder is protected");

        let FsResponse::Info { info } = run(FsRequest::Info { path: shown(&root.join("app.txt")) }, None).unwrap() else { panic!() };
        assert_eq!(info["name"], "app.txt");
        assert_eq!(info["size"], 5);
        assert_eq!(info["is_dir"], false);
        assert!(run(FsRequest::Info { path: shown(&root.join("missing")) }, None).is_err());
        for label in search_labels(777).into_iter().chain(search_labels(778)) {
            crate::fs::forget_search_label(&label);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncated_and_binary_files_cannot_be_silently_overwritten() {
        let root = scratch("explorer-read");
        std::fs::write(root.join("big"), "x".repeat(MAX_BYTES + 1)).unwrap();
        std::fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        std::fs::write(root.join("escaped"), "\u{1}".repeat(MAX_BYTES)).unwrap();
        assert!(matches!(read(&root.join("big")).unwrap(), FsResponse::File { truncated: true, version: None, .. }));
        assert!(read(&root.join("binary")).is_err());
        let escaped = read(&root.join("escaped")).unwrap();
        assert!(serde_json::to_vec(&escaped).unwrap().len() < MAX_FRAME - 8192);
        assert!(matches!(escaped, FsResponse::File { truncated: true, version: None, .. }));
        assert!(run(FsRequest::Delete { path: shown(&root) }, Some(&root)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
