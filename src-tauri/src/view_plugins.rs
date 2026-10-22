use base64::Engine;
use flowcode_shared::i18n::tr;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::AppHandle;

/// A view plugin - an "agent view" or a "new tab" page - unlike the
/// declarative JSON ones in plugins.rs, IS code: an HTML/JS/CSS package the
/// frontend renders in a sandboxed iframe, talking to the app only through
/// postMessage. This module stores, validates and serves those files; it never
/// runs any of them. One folder per plugin, `<plugins dir>/views/<id>/`, with
/// `manifest.json` at its root.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ViewPluginManifest {
    pub id: String,
    /// "agentView" (a way to show an agent session) or "newTab" (the page a
    /// new tab opens on).
    pub kind: String,
    pub api_version: u32,
    pub label: String,
    /// `label` per UI language ("it" / "en"), when it differs.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    /// The HTML page loaded in the iframe, relative to the package root.
    pub entry: String,
    /// An agent view's feed: always "acp" (the Agent Client Protocol stream).
    /// A new tab page has none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transport: String,
    /// Subset of "desktop" | "tablet" | "phone"; a new tab page is "desktop" only.
    pub devices: Vec<String>,
    /// What the view may ask the app to do on its behalf: a subset of "send" |
    /// "cancel" | "setMode" | "openFile" for an agent view, of "launch" for a
    /// new tab page.
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// One file of a package being installed. `path` is what the browser's folder
/// picker reports (`webkitRelativePath`), `data` the file's bytes in base64.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub path: String,
    pub data: String,
}

const MANIFEST_FILE: &str = "manifest.json";
/// The only manifest `apiVersion` this build understands.
const API_VERSION: u32 = 1;
/// Ids the app itself already uses, for views and new tab layouts.
const RESERVED_IDS: [&str; 3] = ["chat", "terminal", "glass"];
const DEVICES: [&str; 3] = ["desktop", "tablet", "phone"];
const AGENT_VIEW_PERMISSIONS: [&str; 4] = ["send", "cancel", "setMode", "openFile"];
const NEW_TAB_PERMISSIONS: [&str; 1] = ["launch"];
const MAX_FILES: usize = 500;
pub(crate) const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;
/// What a package may contain - no executables, no archives.
const ALLOWED_EXTENSIONS: [&str; 19] = [
    "html", "htm", "js", "mjs", "css", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2",
    "ttf", "otf", "txt", "md",
];

/// Sent with every served file. Scripts and styles may be inline or from the
/// package itself, but nothing may reach the network (`connect-src 'none'`,
/// no forms, no nested frames, no plugins): a view only ever talks to the app
/// through postMessage.
const VIEW_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; \
form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

pub(crate) fn views_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::plugins::plugins_dir(app)?.join("views");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `^[a-z0-9][a-z0-9_-]{0,63}$`. The id becomes a folder name and a URL
/// segment, so every path built from one goes through this first.
pub(crate) fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A relative path from untrusted input, normalized to forward slashes - or
/// None if it could point anywhere but down inside its package: empty, `.` or
/// `..` segments, absolute and drive paths (`:` never appears in a segment),
/// NUL.
pub(crate) fn sanitize_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let ok = segments.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains([':', '\0']));
    ok.then(|| segments.join("/"))
}

fn extension_of(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

/// If the package has no `manifest.json` at its root but every file sits
/// under one shared top-level folder that does, drops that folder from every
/// path - what a browser folder picker produces.
fn strip_package_root(paths: &[String]) -> Vec<String> {
    if paths.iter().any(|p| p == MANIFEST_FILE) {
        return paths.to_vec();
    }
    let first = |p: &String| p.split('/').next().unwrap_or_default().to_string();
    let Some(root) = paths.first().map(first) else { return paths.to_vec() };
    let shared = paths.iter().all(|p| first(p) == root && p.contains('/'));
    if shared && paths.iter().any(|p| *p == format!("{root}/{MANIFEST_FILE}")) {
        paths.iter().map(|p| p[root.len() + 1..].to_string()).collect()
    } else {
        paths.to_vec()
    }
}

/// Checks a parsed manifest. `has_file` says whether a path exists in the
/// package, for `entry`.
fn validate_manifest(m: &ViewPluginManifest, has_file: impl Fn(&str) -> bool) -> Result<(), String> {
    if !valid_id(&m.id) || RESERVED_IDS.contains(&m.id.as_str()) {
        return Err(tr("Id della vista non valido", "Invalid view id").to_string());
    }
    if m.api_version != API_VERSION {
        return Err(tr("Versione API non supportata", "Unsupported API version").to_string());
    }
    let (transport_ok, devices_ok, permissions): (bool, bool, &[&str]) = match m.kind.as_str() {
        "agentView" => (
            m.transport == "acp",
            !m.devices.is_empty() && m.devices.iter().all(|d| DEVICES.contains(&d.as_str())),
            &AGENT_VIEW_PERMISSIONS,
        ),
        "newTab" => (m.transport.is_empty(), m.devices == ["desktop"], &NEW_TAB_PERMISSIONS),
        _ => return Err(tr("Tipo di plugin non supportato", "Unsupported plugin kind").to_string()),
    };
    if !transport_ok {
        return Err(tr("Trasporto non supportato", "Unsupported transport").to_string());
    }
    if m.label.trim().is_empty() || m.label.chars().count() > 60 {
        return Err(tr("Nome della vista non valido (1-60 caratteri)", "Invalid view name (1-60 characters)").to_string());
    }
    if !devices_ok {
        return Err(tr("Dispositivi non validi", "Invalid devices").to_string());
    }
    if !m.permissions.iter().all(|p| permissions.contains(&p.as_str())) {
        return Err(tr("Permessi non validi", "Invalid permissions").to_string());
    }
    let entry_ok = sanitize_path(&m.entry).is_some_and(|e| extension_of(&e) == "html" && has_file(&e));
    if !entry_ok {
        return Err(tr("Pagina di ingresso mancante o non valida", "Missing or invalid entry page").to_string());
    }
    Ok(())
}

/// Reads and validates `<dir>/manifest.json`.
pub(crate) fn read_manifest(dir: &Path) -> Result<ViewPluginManifest, String> {
    let contents = std::fs::read_to_string(dir.join(MANIFEST_FILE)).map_err(|e| e.to_string())?;
    let manifest: ViewPluginManifest = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    validate_manifest(&manifest, |entry| dir.join(entry).is_file())?;
    Ok(manifest)
}

#[tauri::command]
pub fn view_plugins_list(app: AppHandle) -> Result<Vec<ViewPluginManifest>, String> {
    let dir = views_dir(&app)?;
    let mut views = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match read_manifest(&entry.path()) {
            // The folder name is what the scheme handler serves from, so it
            // has to be the id.
            Ok(manifest) if manifest.id == name => views.push(manifest),
            Ok(manifest) => eprintln!("view plugins: skipping {name}: folder doesn't match id {}", manifest.id),
            Err(e) => eprintln!("view plugins: skipping invalid view {name}: {e}"),
        }
    }
    views.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(views)
}

/// Decodes, checks and writes a package, then swaps it in for any previous
/// version of the same view. Everything is validated before the first byte
/// is written, and the files land in a temp sibling folder first, so a
/// failure never leaves a half-written plugin behind. Fails with
/// `exists:<id>` when the view is installed and `overwrite` is false.
#[tauri::command]
pub async fn view_plugin_install(
    app: AppHandle,
    files: Vec<PackageFile>,
    overwrite: bool,
) -> Result<ViewPluginManifest, String> {
    let dir = views_dir(&app)?;
    crate::blocking(move || install_package(&dir, files, overwrite)).await
}

fn install_package(views: &Path, files: Vec<PackageFile>, overwrite: bool) -> Result<ViewPluginManifest, String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(tr("Pacchetto vuoto o con troppi file", "Package is empty or has too many files").to_string());
    }
    let bad_path = || tr("Percorso non valido nel pacchetto", "Invalid path in the package").to_string();
    let paths = files.iter().map(|f| sanitize_path(&f.path).ok_or_else(bad_path)).collect::<Result<Vec<_>, _>>()?;
    let paths = strip_package_root(&paths);

    let mut seen = HashSet::new();
    let mut total = 0;
    let mut contents = Vec::with_capacity(files.len());
    for (path, file) in paths.iter().zip(&files) {
        if !ALLOWED_EXTENSIONS.contains(&extension_of(path).as_str()) {
            return Err(format!("{}: {path}", tr("Tipo di file non consentito", "File type not allowed")));
        }
        if !seen.insert(path.clone()) {
            return Err(format!("{}: {path}", tr("File duplicato", "Duplicate file")));
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(file.data.trim()).map_err(|e| e.to_string())?;
        total += bytes.len();
        if bytes.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return Err(tr("Pacchetto troppo grande", "Package is too large").to_string());
        }
        contents.push(bytes);
    }

    let manifest_bytes = paths.iter().position(|p| p == MANIFEST_FILE).map(|i| &contents[i]).ok_or_else(|| {
        tr("manifest.json mancante nel pacchetto", "manifest.json is missing from the package").to_string()
    })?;
    let manifest: ViewPluginManifest = serde_json::from_slice(manifest_bytes).map_err(|e| e.to_string())?;
    validate_manifest(&manifest, |entry| seen.contains(entry))?;

    let target = views.join(&manifest.id);
    if target.exists() && !overwrite {
        return Err(format!("exists:{}", manifest.id));
    }
    let staging = views.join(format!(".{}.tmp-{}", manifest.id, uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        for (path, bytes) in paths.iter().zip(&contents) {
            let file = staging.join(path);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(file, bytes)?;
        }
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&staging, &target)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }
    Ok(manifest)
}

#[tauri::command]
pub fn view_plugin_delete(app: AppHandle, id: String) -> Result<(), String> {
    // Checked before any path is built from it.
    if !valid_id(&id) {
        return Err(tr("Id della vista non valido", "Invalid view id").to_string());
    }
    match std::fs::remove_dir_all(views_dir(&app)?.join(&id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
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

/// A request path (`/<id>/<file>`) split into the plugin id and the
/// sanitized file path inside it.
fn split_request_path(uri_path: &str) -> Option<(String, String)> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'))?;
    let (id, rest) = decoded.split_once('/')?;
    if !valid_id(id) {
        return None;
    }
    Some((id.to_string(), sanitize_path(rest)?))
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

/// The file a request asks for, if it exists inside its plugin's folder.
/// Canonicalized and re-checked against the folder, so a symlink inside a
/// package can't lead out of it.
pub(crate) fn resolve_file(views: &Path, id: &str, rel: &str) -> Option<PathBuf> {
    let root = views.join(id).canonicalize().ok()?;
    let file = root.join(rel).canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

/// Handler of the `flowcode-plugin` URI scheme. The frontend builds URLs with
/// `pluginFileUrl(convertFileSrc("<id>", "flowcode-plugin"), "<entry>")`, which
/// is `http://flowcode-plugin.localhost/<id>/<entry>` on Windows and
/// `flowcode-plugin://localhost/<id>/<entry>` elsewhere, so the page's
/// relative files resolve next to it.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return respond(StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new());
    }
    let served = split_request_path(request.uri().path()).and_then(|(id, rel)| {
        let file = resolve_file(&views_dir(app).ok()?, &id, &rel)?;
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

    fn manifest() -> ViewPluginManifest {
        serde_json::from_str(
            r#"{ "id": "timeline", "kind": "agentView", "apiVersion": 1, "label": "Timeline",
                 "entry": "index.html", "transport": "acp", "devices": ["desktop", "phone"],
                 "permissions": ["send"], "unknownField": true }"#,
        )
        .unwrap()
    }

    fn new_tab_manifest() -> ViewPluginManifest {
        serde_json::from_str(
            r#"{ "id": "minimal", "kind": "newTab", "apiVersion": 1, "label": "Minimal",
                 "entry": "index.html", "devices": ["desktop"], "permissions": ["launch"] }"#,
        )
        .unwrap()
    }

    fn has_index(path: &str) -> bool {
        path == "index.html"
    }

    #[test]
    fn sanitizes_paths() {
        assert_eq!(sanitize_path("a/b.js").as_deref(), Some("a/b.js"));
        assert_eq!(sanitize_path("a\\b.js").as_deref(), Some("a/b.js"));
        for bad in ["../x", "a/../../x", "C:\\x", "/x", "a//b", "a/./b", "", "a/b\0c"] {
            assert!(sanitize_path(bad).is_none(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn strips_a_shared_package_root() {
        let paths = |list: &[&str]| list.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let picked = paths(&["tl/manifest.json", "tl/index.html", "tl/js/app.js"]);
        assert_eq!(strip_package_root(&picked), paths(&["manifest.json", "index.html", "js/app.js"]));
        let flat = paths(&["manifest.json", "index.html"]);
        assert_eq!(strip_package_root(&flat), flat);
        let no_manifest = paths(&["tl/index.html"]);
        assert_eq!(strip_package_root(&no_manifest), no_manifest);
        let two_roots = paths(&["a/manifest.json", "b/index.html"]);
        assert_eq!(strip_package_root(&two_roots), two_roots);
    }

    #[test]
    fn validates_manifests() {
        assert!(validate_manifest(&manifest(), has_index).is_ok());
        let bad = |edit: &dyn Fn(&mut ViewPluginManifest)| {
            let mut m = manifest();
            edit(&mut m);
            assert!(validate_manifest(&m, has_index).is_err());
        };
        bad(&|m| m.id = "Bad Id".into());
        bad(&|m| m.id = "chat".into());
        bad(&|m| m.id = "terminal".into());
        bad(&|m| m.id = "a".repeat(65));
        bad(&|m| m.kind = "other".into());
        bad(&|m| m.api_version = 2);
        bad(&|m| m.transport = "ws".into());
        bad(&|m| m.label = "  ".into());
        bad(&|m| m.label = "x".repeat(61));
        bad(&|m| m.devices = vec![]);
        bad(&|m| m.devices = vec!["watch".into()]);
        bad(&|m| m.permissions = vec!["root".into()]);
        bad(&|m| m.entry = "main.html".into());
        bad(&|m| m.entry = "index.js".into());
        bad(&|m| m.entry = "../index.html".into());
    }

    #[test]
    fn validates_new_tab_manifests() {
        assert!(validate_manifest(&new_tab_manifest(), has_index).is_ok());
        let mut no_permissions = new_tab_manifest();
        no_permissions.permissions.clear();
        assert!(validate_manifest(&no_permissions, has_index).is_ok());
        let bad = |edit: &dyn Fn(&mut ViewPluginManifest)| {
            let mut m = new_tab_manifest();
            edit(&mut m);
            assert!(validate_manifest(&m, has_index).is_err());
        };
        bad(&|m| m.id = "glass".into());
        bad(&|m| m.id = "terminal".into());
        bad(&|m| m.transport = "acp".into());
        bad(&|m| m.devices = vec![]);
        bad(&|m| m.devices = vec!["desktop".into(), "phone".into()]);
        bad(&|m| m.devices = vec!["phone".into()]);
        bad(&|m| m.permissions = vec!["send".into()]);
        bad(&|m| m.permissions = vec!["launch".into(), "openFile".into()]);
        bad(&|m| m.entry = "main.html".into());
    }

    #[test]
    fn agent_view_keeps_its_own_permissions() {
        let mut m = manifest();
        m.permissions = vec!["launch".into()];
        assert!(validate_manifest(&m, has_index).is_err());
    }

    #[test]
    fn decodes_and_splits_request_paths() {
        assert_eq!(
            split_request_path("/timeline%2Findex.html"),
            Some(("timeline".to_string(), "index.html".to_string()))
        );
        assert_eq!(
            split_request_path("/timeline/js/app%20x.js"),
            Some(("timeline".to_string(), "js/app x.js".to_string()))
        );
        assert!(split_request_path("/timeline%2F..%2F..%2Fx").is_none());
        assert!(split_request_path("/Bad%2Findex.html").is_none());
        assert!(split_request_path("/timeline").is_none());
        assert!(split_request_path("/timeline%2F%zz").is_none());
    }
}
