//! Account profiles: run Claude Code, Codex CLI and Mistral Vibe under a
//! separate account. Each CLI keeps its whole state (login, settings,
//! sessions, usage) in one folder picked by an env var, so a profile is just
//! three private folders plus the env vars pointing the CLIs at them.
//!
//! The implicit "default" profile (no env vars, the CLIs' normal folders) is
//! never stored: it is `None` / an absent id everywhere.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use tauri::{AppHandle, Manager};

use crate::util::lock;

/// A named account profile, as stored in `profiles.json`.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// The three folders a profile's CLIs use. For the default profile they are the
/// CLIs' own defaults, honouring CLAUDE_CONFIG_DIR / CODEX_HOME / VIBE_HOME if
/// Flowcode's own process env has them (same lookups as spend.rs / vibe.rs).
pub struct ProfileDirs {
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub vibe: PathBuf,
    /// Gemini CLI's `GEMINI_CLI_HOME`: the folder it creates `.gemini` in.
    pub gemini: PathBuf,
    /// OpenCode's config folder (`OPENCODE_CONFIG_DIR` for a named profile).
    pub opencode_config: PathBuf,
    /// OpenCode's sqlite database (sessions and credentials; `OPENCODE_DB`).
    pub opencode_db: PathBuf,
}

/// On-disk shape of `profiles.json`.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct Store {
    #[serde(default)]
    profiles: Vec<Profile>,
    /// Normalized project path (see `norm_key`) -> profile id.
    #[serde(default)]
    project_defaults: HashMap<String, String>,
}

#[derive(serde::Serialize)]
pub struct LoginState {
    pub claude: bool,
    pub codex: bool,
    pub vibe: bool,
    pub gemini: bool,
    pub opencode: bool,
}

#[derive(serde::Serialize)]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    /// `<app_config_dir>/profiles/<id>`.
    pub dir: String,
    pub logged_in: LoginState,
    pub accounts: Accounts,
}

/// Who a CLI is signed in as, read off its files: the email of an account
/// login, or the last characters of an API key. Never the key itself.
#[derive(serde::Serialize, Clone)]
pub struct AccountIdent {
    /// "account" or "apiKey".
    pub kind: &'static str,
    /// account: the email. apiKey: "…" + the key's last 4 chars, `None` when unknown.
    pub label: Option<String>,
    /// Claude's organization, Codex's ChatGPT plan, Vibe's plan.
    pub detail: Option<String>,
}

#[derive(serde::Serialize, Default)]
pub struct Accounts {
    pub claude: Option<AccountIdent>,
    pub codex: Option<AccountIdent>,
    pub vibe: Option<AccountIdent>,
    pub gemini: Option<AccountIdent>,
}

#[derive(serde::Serialize)]
pub struct ProfilesState {
    pub profiles: Vec<ProfileInfo>,
    pub project_defaults: HashMap<String, String>,
    /// The default profile's login state; `None` when the home folder can't be found.
    pub default_logged_in: Option<LoginState>,
    /// Who the default profile's CLIs are signed in as.
    pub default_accounts: Option<Accounts>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("profiles.json"))
}

fn profiles_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("profiles"))
}

/// Serializes the load-modify-save of every command that changes the store,
/// so two of them can't each save over the other's change.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// The store as last read, with the file's mtime then.
static LOADED: Mutex<Option<(Option<SystemTime>, Store)>> = Mutex::new(None);

/// Read on every call (other modules call in from anywhere, polling), but
/// parsed again only when the file's mtime changed: a missing or corrupt file
/// just means no extra profiles.
fn load(app: &AppHandle) -> Store {
    let Ok(path) = store_path(app) else { return Store::default() };
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    if let Some((at, store)) = lock(&LOADED).as_ref() {
        if mtime.is_some() && *at == mtime {
            return store.clone();
        }
    }
    let store: Store = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    *lock(&LOADED) = Some((mtime, store.clone()));
    store
}

/// Written atomically (see `fs::write_atomic`), so a crash mid-write can never
/// leave a half-written (and then silently discarded) profiles list.
fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let written = crate::fs::write_atomic(&path, json.as_bytes()).map_err(|e| e.to_string());
    // Dropped after the write: the file's mtime may not have moved yet.
    *lock(&LOADED) = None;
    written
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The CLIs' own folders, as they would resolve for Flowcode's process.
fn default_dirs() -> Option<ProfileDirs> {
    let home = crate::fs::user_home()?;
    Some(ProfileDirs {
        claude: env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
        codex: env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
        vibe: crate::vibe::vibe_home()?,
        opencode_config: home.join(".config").join("opencode"),
        opencode_db: home.join(".local").join("share").join("opencode").join("opencode.db"),
        gemini: env_dir("GEMINI_CLI_HOME").unwrap_or(home),
    })
}

fn profile_dirs(root: &Path, id: &str) -> ProfileDirs {
    let base = root.join(id);
    ProfileDirs { claude: base.join("claude"), codex: base.join("codex"), vibe: base.join("vibe"), gemini: base.join("gemini"),
        opencode_config: base.join("opencode").join("config"),
        opencode_db: base.join("opencode").join("opencode.db"),
    }
}

/// The folders of `profile` (`None` = default). `None` back when the home
/// folder can't be found or the id is unknown.
pub fn dirs(app: &AppHandle, profile: Option<&str>) -> Option<ProfileDirs> {
    match profile {
        None => default_dirs(),
        Some(id) => {
            if !load(app).profiles.iter().any(|p| p.id == id) {
                return None;
            }
            Some(profile_dirs(&profiles_root(app).ok()?, id))
        }
    }
}

/// Env vars to set on a process launched under `profile`: none for the default
/// profile (the CLIs then use their own folders), else one per CLI.
pub fn env_for(app: &AppHandle, profile: Option<&str>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(id) = profile {
    let Some(d) = dirs(app, Some(id)) else { return Vec::new() };
    let s = |p: &Path| p.to_string_lossy().into_owned();
    env.extend([
        ("CLAUDE_CONFIG_DIR".to_string(), s(&d.claude)),
        ("CODEX_HOME".to_string(), s(&d.codex)),
        ("VIBE_HOME".to_string(), s(&d.vibe)),
        ("GEMINI_CLI_HOME".to_string(), s(&d.gemini)),
        ("OPENCODE_CONFIG_DIR".to_string(), s(&d.opencode_config)),
        ("OPENCODE_DB".to_string(), s(&d.opencode_db)),
        // Vibe stores its API key in the OS keyring, which is shared by the
        // whole OS user and would make every profile (and the default one)
        // use the same key. With the keyring off it falls back to
        // `<VIBE_HOME>/.env`, which is per profile.
        ("VIBE_TEST_DISABLE_KEYRING".to_string(), "1".to_string()),
    ]);
    }
    env
}

/// Credentials belong to this provider's process, never a general terminal.
pub fn env_for_cli(app: &AppHandle, profile: Option<&str>, cli: &str) -> Vec<(String, String)> {
    let mut env = env_for(app, profile);
    env.extend(crate::provider_auth_keys::env_for_cli(app, profile, cli));
    env
}

/// Every profile, the default one first.
pub fn all_dirs(app: &AppHandle) -> Vec<(Option<String>, ProfileDirs)> {
    let mut out = Vec::new();
    if let Some(d) = default_dirs() {
        out.push((None, d));
    }
    if let Ok(root) = profiles_root(app) {
        for p in load(app).profiles {
            let d = profile_dirs(&root, &p.id);
            out.push((Some(p.id), d));
        }
    }
    out
}

/// Cheap, file-only login check. Claude keeps OAuth in `.credentials.json` on
/// Windows/Linux (the keychain on macOS, where the account shows up in
/// `.claude.json` instead), or an API key in `.claude.json`.
fn login_state(app: &AppHandle, d: &ProfileDirs, profile: Option<&str>, use_keyring: bool) -> LoginState {
    let claude = d.claude.join(".credentials.json").exists()
        || std::fs::read_to_string(d.claude.join(".claude.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .is_some_and(|v| {
                let account = v.get("oauthAccount").is_some_and(|a| match a {
                    serde_json::Value::Null => false,
                    serde_json::Value::Object(o) => !o.is_empty(),
                    serde_json::Value::String(s) => !s.is_empty(),
                    _ => true,
                });
                account || v.get("primaryApiKey").is_some_and(|k| !k.is_null())
            });
    let codex = d.codex.join("auth.json").exists();
    // The OS keyring only counts for the default profile (named ones run
    // with it off, see `env_for`).
    let vibe = crate::vibe::has_api_key(Some(&d.vibe), use_keyring);
    let gemini = crate::gemini::has_login(&d.gemini);
    // OpenCode keeps its credentials inside the sqlite database, unreadable
    // here: a database that has content is the best file-only hint.
    let opencode = std::fs::metadata(&d.opencode_db).is_ok_and(|m| m.len() > 0);
    LoginState {
        claude: claude || crate::provider_auth_keys::has_key(app, "claude", profile),
        codex: codex || crate::provider_auth_keys::has_key(app, "codex", profile),
        vibe: vibe || crate::provider_auth_keys::has_key(app, "vibe", profile),
        gemini: gemini || crate::provider_auth_keys::has_key(app, "gemini", profile),
        opencode,
    }
}

/// The last 4 characters of an API key for display, never the key. `None` for
/// anything too short to be a real key.
pub(crate) fn key_hint(key: &str) -> Option<String> {
    let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
    let count = key.chars().count();
    if count >= 12 {
        let tail: String = key.chars().skip(count - 4).collect();
        Some(format!("…{tail}"))
    } else {
        None
    }
}

/// Dotenv lookup of `key` in `env`.
fn env_value(env: &str, key: &str) -> Option<String> {
    env.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let (k, v) = line.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
        (!v.is_empty()).then(|| v.to_string())
    })
}

fn non_empty_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|s| s.as_str()).filter(|s| !s.is_empty())
}

fn claude_ident(v: &serde_json::Value) -> Option<AccountIdent> {
    if let Some(account) = v.get("oauthAccount") {
        if let Some(email) = non_empty_str(account, "emailAddress") {
            return Some(AccountIdent {
                kind: "account",
                label: Some(email.to_string()),
                detail: non_empty_str(account, "organizationName").map(str::to_string),
            });
        }
    }
    let key = non_empty_str(v, "primaryApiKey")?;
    Some(AccountIdent { kind: "apiKey", label: key_hint(key), detail: None })
}

/// Reads the email and plan out of Codex's `id_token`. The JWT signature is NOT
/// verified: this is display only, never an authorization decision.
fn codex_ident(v: &serde_json::Value) -> Option<AccountIdent> {
    use base64::Engine;
    let from_token = v
        .get("tokens")
        .and_then(|t| non_empty_str(t, "id_token"))
        .and_then(|token| {
            let payload = token.split('.').nth(1)?.trim_end_matches('=');
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
            let payload: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            let email = non_empty_str(&payload, "email")?.to_string();
            let detail = payload
                .get("https://api.openai.com/auth")
                .and_then(|a| non_empty_str(a, "chatgpt_plan_type"))
                .map(|plan| {
                    let mut chars = plan.chars();
                    let first: String = chars.next().into_iter().flat_map(char::to_uppercase).collect();
                    format!("ChatGPT {first}{}", chars.as_str())
                });
            Some(AccountIdent { kind: "account", label: Some(email), detail })
        });
    if from_token.is_some() {
        return from_token;
    }
    let key = non_empty_str(v, "OPENAI_API_KEY")?;
    Some(AccountIdent { kind: "apiKey", label: key_hint(key), detail: None })
}

/// First plan name found in Vibe's `whoami_cache.json`.
fn vibe_plan(v: &serde_json::Value) -> Option<String> {
    v.as_object()?
        .values()
        .find_map(|e| e.get("payload").and_then(|p| non_empty_str(p, "plan_name")))
        .map(str::to_string)
}

/// Claude's global `.claude.json`: in the home folder for the default profile
/// unless CLAUDE_CONFIG_DIR moves it, else inside the profile's Claude folder.
fn claude_global_json(d: &ProfileDirs, profile: Option<&str>) -> PathBuf {
    if profile.is_none() && env_dir("CLAUDE_CONFIG_DIR").is_none() {
        if let Some(home) = crate::fs::user_home() {
            return home.join(".claude.json");
        }
    }
    d.claude.join(".claude.json")
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    if std::fs::metadata(path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Who each CLI is signed in as. File-only and cheap, like `login_state`.
/// OpenCode is left out: its credentials can only be listed by running the CLI.
fn accounts(app: &AppHandle, d: &ProfileDirs, profile: Option<&str>, use_keyring: bool) -> Accounts {
    let vibe_plan = read_json(&d.vibe.join("whoami_cache.json")).as_ref().and_then(vibe_plan);
    let saved_key = |cli: &str| crate::provider_auth_keys::method(app, cli, profile).as_deref() == Some("apiKey");
    let saved = |cli: &str, detail: Option<String>| AccountIdent {
        kind: "apiKey",
        label: crate::provider_auth_keys::key_hint(app, cli, profile),
        detail,
    };

    let claude = if saved_key("claude") {
        Some(saved("claude", None))
    } else {
        read_json(&claude_global_json(d, profile)).as_ref().and_then(claude_ident)
    };
    let codex = if saved_key("codex") {
        Some(saved("codex", None))
    } else {
        read_json(&d.codex.join("auth.json")).as_ref().and_then(codex_ident)
    };
    let gemini = if saved_key("gemini") {
        Some(saved("gemini", None))
    } else {
        let gdir = d.gemini.join(".gemini");
        let active = read_json(&gdir.join("google_accounts.json"))
            .and_then(|v| non_empty_str(&v, "active").map(str::to_string));
        if let Some(email) = active {
            Some(AccountIdent { kind: "account", label: Some(email), detail: None })
        } else {
            std::fs::read_to_string(gdir.join(".env")).ok().and_then(|env| {
                let key = env_value(&env, "GEMINI_API_KEY").or_else(|| env_value(&env, "GOOGLE_API_KEY"))?;
                Some(AccountIdent { kind: "apiKey", label: key_hint(&key), detail: None })
            })
        }
    };
    let vibe = if saved_key("vibe") {
        Some(saved("vibe", vibe_plan))
    } else {
        let hint = std::fs::read_to_string(d.vibe.join(".env"))
            .ok()
            .and_then(|env| env_value(&env, "MISTRAL_API_KEY"))
            .or_else(|| std::env::var("MISTRAL_API_KEY").ok().filter(|k| !k.is_empty()))
            .and_then(|k| key_hint(&k));
        if hint.is_some() || crate::vibe::has_api_key(Some(&d.vibe), use_keyring) {
            Some(AccountIdent { kind: "apiKey", label: hint, detail: vibe_plan })
        } else {
            None
        }
    };
    Accounts { claude, codex, vibe, gemini }
}

/// Folder-name-safe id stem: lowercase ascii alphanumerics and single dashes,
/// capped at 20 chars.
fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' };
        if c == '-' && slug.ends_with('-') {
            continue;
        }
        slug.push(c);
    }
    let slug: String = slug.trim_matches('-').chars().take(20).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "profile".to_string()
    } else {
        slug
    }
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Shared by create and update: a non-empty trimmed name, unique ignoring case
/// among the other profiles, and a `#rrggbb` colour. Returns the trimmed name.
fn validate(store: &Store, own_id: Option<&str>, name: &str, color: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The name can't be empty".to_string());
    }
    let lower = name.to_lowercase();
    if store.profiles.iter().any(|p| Some(p.id.as_str()) != own_id && p.name.to_lowercase() == lower) {
        return Err("A profile with this name already exists".to_string());
    }
    if !valid_color(color) {
        return Err("The color must look like #rrggbb".to_string());
    }
    Ok(name.to_string())
}

/// Key under which a project folder is stored in `project_defaults`: native
/// separators, no trailing separator, and lowercase on Windows where paths are
/// case-insensitive.
fn norm_key(path: &str) -> String {
    let p = if cfg!(windows) { path.replace('/', "\\").to_lowercase() } else { path.to_string() };
    let trimmed = p.trim_end_matches(['/', '\\']);
    // A bare root ("/" or "C:\") would trim to nothing / lose its separator.
    if trimmed.is_empty() {
        return p;
    }
    trimmed.to_string()
}

/// The default of the deepest folder that contains `key` (or equals it), so a
/// default set on a repo also covers its sub-folders and worktrees, while a
/// more specific entry still wins. `exists` drops entries whose profile is gone.
fn best_match(
    defaults: &HashMap<String, String>,
    key: &str,
    sep: char,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    defaults
        .iter()
        .filter(|(k, id)| {
            exists(id)
                && (k.as_str() == key
                    || (key.starts_with(k.as_str())
                        && (k.ends_with(sep) || key[k.len()..].starts_with(sep))))
        })
        .max_by_key(|(k, _)| k.len())
        .map(|(_, id)| id.clone())
}

fn sep() -> char {
    if cfg!(windows) {
        '\\'
    } else {
        '/'
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // Symlinks are resolved so a linked folder is copied as a folder
        // (`file_type()` alone would send it to `fs::copy`, which fails).
        let file_type = entry.file_type()?;
        let is_dir = if file_type.is_symlink() { std::fs::metadata(entry.path())?.is_dir() } else { file_type.is_dir() };
        if is_dir {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Copies the listed files/folders that exist from `from` into `to`. A failed
/// item is ignored: seeding a new profile is a convenience, never a reason to
/// refuse creating it.
fn copy_items(from: &Path, to: &Path, items: &[&str]) {
    for item in items {
        let src = from.join(item);
        let dst = to.join(item);
        let _ = if src.is_dir() {
            copy_dir(&src, &dst)
        } else if src.is_file() {
            std::fs::copy(&src, &dst).map(|_| ())
        } else {
            Ok(())
        };
    }
}

/// Seeds a new profile with the default profile's settings. Only configuration
/// is copied - never credentials, sessions, history or logs - so the new
/// account starts clean but familiar. MCP servers live in Claude's global
/// `.claude.json` together with login data, so just that key is carried over.
fn copy_settings_from_default(new: &ProfileDirs) {
    let Some(def) = default_dirs() else { return };
    copy_items(
        &def.claude,
        &new.claude,
        &["settings.json", "CLAUDE.md", "commands", "agents", "skills", "output-styles"],
    );
    let global = claude_global_json(&def, None);
    let servers = std::fs::read_to_string(global)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("mcpServers").filter(|s| s.is_object()).cloned());
    if let Some(servers) = servers {
        let doc = serde_json::json!({ "mcpServers": servers });
        if let Ok(json) = serde_json::to_string_pretty(&doc) {
            let _ = std::fs::write(new.claude.join(".claude.json"), json);
        }
    }
    copy_items(&def.codex, &new.codex, &["config.toml", "AGENTS.md", "prompts"]);
    copy_items(&def.vibe, &new.vibe, &["config.toml", "prompts", "agents"]);
    copy_items(&def.gemini.join(".gemini"), &new.gemini.join(".gemini"), &["settings.json", "GEMINI.md", "commands"]);
    copy_items(
        &def.opencode_config,
        &new.opencode_config,
        &["opencode.json", "opencode.jsonc", "AGENTS.md", "agent", "agents", "command", "commands", "skills", "plugin", "plugins"],
    );
}

#[tauri::command]
pub async fn profiles_list(app: AppHandle) -> Result<ProfilesState, String> {
    crate::blocking(move || {
        let root = profiles_root(&app)?;
        let store = load(&app);
        let profiles = store
            .profiles
            .into_iter()
            .map(|p| {
                let dirs = profile_dirs(&root, &p.id);
                let logged_in = login_state(&app, &dirs, Some(&p.id), false);
                let accounts = accounts(&app, &dirs, Some(&p.id), false);
                let dir = root.join(&p.id).to_string_lossy().into_owned();
                ProfileInfo { id: p.id, name: p.name, color: p.color, dir, logged_in, accounts }
            })
            .collect();
        Ok(ProfilesState {
            profiles,
            project_defaults: store.project_defaults,
            default_logged_in: default_dirs().map(|d| login_state(&app, &d, None, true)),
            default_accounts: default_dirs().map(|d| accounts(&app, &d, None, true)),
        })
    })
    .await
}

#[tauri::command]
pub async fn profile_create(
    app: AppHandle,
    name: String,
    color: String,
    copy_settings: bool,
) -> Result<Profile, String> {
    crate::blocking(move || {
        let _guard = lock(&STORE_LOCK);
        let mut store = load(&app);
        let name = validate(&store, None, &name, &color)?;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let id = format!("{}-{}", slug(&name), &suffix[..6]);
        let d = profile_dirs(&profiles_root(&app)?, &id);
        for dir in [&d.claude, &d.codex, &d.vibe, &d.gemini.join(".gemini"), &d.opencode_config] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if copy_settings {
            copy_settings_from_default(&d);
        }
        let profile = Profile { id, name, color };
        store.profiles.push(profile.clone());
        save(&app, &store)?;
        Ok(profile)
    })
    .await
}

#[tauri::command]
pub async fn profile_update(app: AppHandle, id: String, name: String, color: String) -> Result<(), String> {
    crate::blocking(move || {
        let _guard = lock(&STORE_LOCK);
        let mut store = load(&app);
        let name = validate(&store, Some(&id), &name, &color)?;
        let profile = store.profiles.iter_mut().find(|p| p.id == id).ok_or("Unknown profile")?;
        profile.name = name;
        profile.color = color;
        save(&app, &store)
    })
    .await
}

#[tauri::command]
pub async fn profile_delete(app: AppHandle, id: String, delete_files: bool) -> Result<(), String> {
    crate::blocking(move || {
        let _guard = lock(&STORE_LOCK);
        let mut store = load(&app);
        store.profiles.retain(|p| p.id != id);
        store.project_defaults.retain(|_, v| *v != id);
        save(&app, &store)?;
        if delete_files {
            let root = profiles_root(&app)?;
            let target = root.join(&id);
            // The id comes from the frontend: only ever remove something that
            // really sits inside the profiles folder (`..` and symlinks included).
            if let (Ok(root), Ok(target)) = (root.canonicalize(), target.canonicalize()) {
                if target != root && target.starts_with(&root) {
                    std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn profile_for_path(app: AppHandle, path: String) -> Result<Option<String>, String> {
    crate::blocking(move || {
        let store = load(&app);
        let key = norm_key(&path);
        Ok(best_match(&store.project_defaults, &key, sep(), |id| {
            store.profiles.iter().any(|p| p.id == id)
        }))
    })
    .await
}

/// How long a CLI's logout command may run.
const LOGOUT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Signs `cli` out of profile `id` (`None` = the default one). Claude Code and
/// Codex have a logout command, run under the profile's folders; Vibe has
/// none, so its API key is removed from where `has_api_key` finds it.
#[tauri::command]
pub async fn profile_logout(app: AppHandle, id: Option<String>, cli: String) -> Result<(), String> {
    crate::blocking(move || {
        let id = id.as_deref();
        let d = dirs(&app, id).ok_or_else(|| "profile not found".to_string())?;
        crate::provider_auth_keys::clear(&app, &cli, id)?;
        let command = match cli.as_str() {
            "claude" => "claude auth logout",
            "codex" => "codex logout",
            "vibe" => return crate::vibe::remove_api_key(&d.vibe, id.is_none()),
            "gemini" => return crate::gemini::logout(&d.gemini),
            "opencode" => return crate::opencode::logout(&env_for(&app, id), id.is_some(), LOGOUT_TIMEOUT),
            _ => return Err(format!("unknown CLI: {cli}")),
        };
        let out = flowcode_shared::run_command_blocking_timeout(command, &env_for(&app, id), LOGOUT_TIMEOUT)
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("`{command}` failed") } else { err })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_hint_masks() {
        assert_eq!(key_hint("short"), None);
        assert_eq!(key_hint("sk-abcdefghijkl1234").as_deref(), Some("…1234"));
        assert_eq!(key_hint("  \"sk-abcdefghijkl1234\" ").as_deref(), Some("…1234"));
    }

    #[test]
    fn env_value_lookup() {
        let env = "# c\nexport FOO = \"bar\"\nMISTRAL_API_KEY='abc'\nEMPTY=\n";
        assert_eq!(env_value(env, "FOO").as_deref(), Some("bar"));
        assert_eq!(env_value(env, "MISTRAL_API_KEY").as_deref(), Some("abc"));
        assert_eq!(env_value(env, "EMPTY"), None);
        assert_eq!(env_value(env, "NOPE"), None);
    }

    #[test]
    fn claude_ident_cases() {
        let v = serde_json::json!({"oauthAccount": {"emailAddress": "a@b.c", "organizationName": "Org"}});
        let i = claude_ident(&v).unwrap();
        assert_eq!((i.kind, i.label.as_deref(), i.detail.as_deref()), ("account", Some("a@b.c"), Some("Org")));
        let v = serde_json::json!({"primaryApiKey": "sk-ant-abcdefghijkl9876"});
        let i = claude_ident(&v).unwrap();
        assert_eq!((i.kind, i.label.as_deref(), i.detail), ("apiKey", Some("…9876"), None));
        assert!(claude_ident(&serde_json::json!({})).is_none());
        assert!(claude_ident(&serde_json::json!({"oauthAccount": {"emailAddress": ""}, "primaryApiKey": ""})).is_none());
    }

    #[test]
    fn codex_ident_cases() {
        use base64::Engine;
        let payload = r#"{"email":"a@b.c","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#;
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let v = serde_json::json!({"tokens": {"id_token": format!("e30.{enc}.sig")}});
        let i = codex_ident(&v).unwrap();
        assert_eq!((i.kind, i.label.as_deref(), i.detail.as_deref()), ("account", Some("a@b.c"), Some("ChatGPT Plus")));
        let v = serde_json::json!({"OPENAI_API_KEY": "sk-abcdefghijkl5555"});
        let i = codex_ident(&v).unwrap();
        assert_eq!((i.kind, i.label.as_deref()), ("apiKey", Some("…5555")));
        assert!(codex_ident(&serde_json::json!({})).is_none());
    }

    #[test]
    fn vibe_plan_first_non_empty() {
        let v = serde_json::json!({"h1": {"payload": {"plan_name": ""}}, "h2": {"payload": {"plan_name": "Pro"}}});
        assert_eq!(vibe_plan(&v).as_deref(), Some("Pro"));
        assert_eq!(vibe_plan(&serde_json::json!({})), None);
    }

    #[test]
    fn slug_rules() {
        assert_eq!(slug("Work Account!"), "work-account");
        assert_eq!(slug("  --  "), "profile");
        assert_eq!(slug("àèì"), "profile");
        assert_eq!(slug("abcdefghijklmnopqrstuvwxyz").len(), 20);
        assert!(!slug("a very long profile name indeed").ends_with('-'));
    }

    #[test]
    fn color_validation() {
        assert!(valid_color("#4f8cff"));
        assert!(valid_color("#ABCDEF"));
        assert!(!valid_color("4f8cff"));
        assert!(!valid_color("#4f8cf"));
        assert!(!valid_color("#4f8cfg"));
        assert!(!valid_color("#4f8cffa"));
    }

    #[test]
    fn norm_key_trims_and_folds() {
        if cfg!(windows) {
            assert_eq!(norm_key("C:/Users/Me/Repo/"), "c:\\users\\me\\repo");
            assert_eq!(norm_key("C:\\Users\\Me\\Repo\\\\"), "c:\\users\\me\\repo");
        } else {
            assert_eq!(norm_key("/home/Me/repo/"), "/home/Me/repo");
        }
    }

    #[test]
    fn longest_prefix_wins() {
        let mut d = HashMap::new();
        d.insert("/a/repo".to_string(), "one".to_string());
        d.insert("/a/repo/sub".to_string(), "two".to_string());
        d.insert("/a/gone".to_string(), "dead".to_string());
        let alive = |id: &str| id != "dead";
        assert_eq!(best_match(&d, "/a/repo", '/', alive), Some("one".into()));
        assert_eq!(best_match(&d, "/a/repo/x/y", '/', alive), Some("one".into()));
        assert_eq!(best_match(&d, "/a/repo/sub/z", '/', alive), Some("two".into()));
        // A sibling sharing a name prefix is not inside the folder.
        assert_eq!(best_match(&d, "/a/repository", '/', alive), None);
        assert_eq!(best_match(&d, "/a/gone/x", '/', alive), None);
        assert_eq!(best_match(&d, "/b", '/', alive), None);
    }
}
