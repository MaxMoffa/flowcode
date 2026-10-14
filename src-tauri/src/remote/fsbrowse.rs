//! Directory listing and file reading for the phone, confined to the folder
//! of the tab that asked.

use std::path::{Component, Path, PathBuf};

use flowcode_remote_proto::{self as proto, LsEntry};
use flowcode_shared::i18n::tr;

/// A text file is read up to this size; the rest is cut off.
const MAX_READ_BYTES: usize = 1024 * 1024;

const MAX_LS_ENTRIES: usize = 5000;

fn outside_error() -> String {
    tr("Percorso fuori dalla cartella del terminale", "Path is outside the terminal's folder").to_string()
}

/// `rel` (relative to `root`, or an absolute path inside it) resolved to a
/// real path that is guaranteed to lie within `root`. `..` is refused
/// outright, and canonicalizing both sides resolves symlinks, so a link
/// pointing out of the folder can't be followed either.
fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel.trim());
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(outside_error());
    }
    let root = root
        .canonicalize()
        .map_err(|_| tr("Cartella non disponibile", "Folder not available").to_string())?;
    let full = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    let full = full
        .canonicalize()
        .map_err(|_| tr("Percorso non trovato", "Path not found").to_string())?;
    if !full.starts_with(&root) {
        return Err(outside_error());
    }
    Ok(full)
}

/// `full` as shown to the phone: relative to `root`, `/`-separated, empty for
/// the root itself.
fn display_path(root: &Path, full: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    full.strip_prefix(&root)
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

pub(super) fn list_dir(root: &Path, rel: &str) -> Result<(String, Vec<LsEntry>), String> {
    let dir = confine(root, rel)?;
    let mut entries: Vec<LsEntry> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().take(MAX_LS_ENTRIES) {
        // `metadata` follows symlinks so a link to a folder lists as one; a
        // dangling link falls back to the link's own type.
        let (is_dir, size) = match std::fs::metadata(entry.path()) {
            Ok(m) => (m.is_dir(), (!m.is_dir()).then_some(m.len())),
            Err(_) => (entry.file_type().map(|t| t.is_dir()).unwrap_or(false), None),
        };
        entries.push(LsEntry { name: entry.file_name().to_string_lossy().into_owned(), dir: is_dir, size });
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((display_path(root, &dir), entries))
}

/// A text file's contents, cut at `MAX_READ_BYTES` and then further if the
/// JSON-escaped text wouldn't fit one protocol frame. Binary files are
/// refused (a NUL byte in the first 8 KiB).
pub(super) fn read_text(root: &Path, rel: &str) -> Result<(String, String, bool), String> {
    use std::io::Read;
    let path = confine(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(tr("Non è un file", "Not a file").to_string());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(MAX_READ_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(tr("File binario: non si può mostrare", "Binary file: cannot be shown").to_string());
    }
    let mut truncated = bytes.len() > MAX_READ_BYTES;
    bytes.truncate(MAX_READ_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    // Escaping can inflate text (control characters become six bytes), so
    // trim until the encoded form is safely inside a frame.
    while serde_json::to_string(&text).map(|s| s.len()).unwrap_or(usize::MAX) > proto::MAX_FRAME - 4096 {
        let mut cut = text.len() / 4 * 3;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        truncated = true;
    }
    Ok((display_path(root, &path), text, truncated))
}

#[cfg(test)]
mod tests {
    use super::super::scratch;
    use super::*;

    #[test]
    fn ls_stays_inside_the_tab_folder() {
        let base = scratch("ls");
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("zeta.txt"), "z").unwrap();
        std::fs::write(root.join(".env"), "x").unwrap();
        std::fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(base.join("secret.txt"), "s").unwrap();

        // Dirs first, hidden files included.
        let (path, entries) = list_dir(&root, "").unwrap();
        assert_eq!(path, "");
        let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.dir)).collect();
        assert_eq!(names, vec![("src", true), (".env", false), ("zeta.txt", false)]);
        assert_eq!(list_dir(&root, "src").unwrap().0, "src");

        // Parent traversal, however spelled, and absolute paths outside.
        assert!(list_dir(&root, "..").is_err());
        assert!(list_dir(&root, "src/../..").is_err());
        assert!(list_dir(&root, "../project").is_err());
        assert!(read_text(&root, "../secret.txt").is_err());
        assert!(read_text(&root, base.join("secret.txt").to_str().unwrap()).is_err());
        // An absolute path inside the folder is fine.
        assert!(read_text(&root, root.join("zeta.txt").to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_text_truncates_and_refuses_binary() {
        let root = scratch("read");
        std::fs::write(root.join("big.txt"), "a".repeat(MAX_READ_BYTES + 10)).unwrap();
        std::fs::write(root.join("bin.dat"), [1u8, 0, 2]).unwrap();
        std::fs::write(root.join("small.txt"), "héllo").unwrap();
        let (_, text, truncated) = read_text(&root, "big.txt").unwrap();
        assert!(truncated && text.len() <= MAX_READ_BYTES);
        assert!(read_text(&root, "bin.dat").is_err());
        let (path, text, truncated) = read_text(&root, "small.txt").unwrap();
        assert_eq!((path.as_str(), text.as_str(), truncated), ("small.txt", "héllo", false));
        assert!(read_text(&root, "missing.txt").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn escaped_text_is_cut_to_fit_a_frame() {
        let root = scratch("escape");
        // Control characters encode as six bytes each.
        std::fs::write(root.join("ctl.txt"), "\u{1}".repeat(MAX_READ_BYTES)).unwrap();
        let (_, text, truncated) = read_text(&root, "ctl.txt").unwrap();
        assert!(truncated);
        assert!(serde_json::to_string(&text).unwrap().len() < proto::MAX_FRAME);
        let _ = std::fs::remove_dir_all(&root);
    }
}
