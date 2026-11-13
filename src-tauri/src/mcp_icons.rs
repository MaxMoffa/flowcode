//! The icon of the service behind an MCP server, for the chat's tool calls: the
//! domain comes from the agent's own config (a remote server's URL) or from a
//! table of well-known connectors, and the icon from that site.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;
use crate::util::lock;

const CACHE_ENTRIES: usize = 100;
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CACHE_FAIL_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_SERVER_LEN: usize = 200;

/// Lowercase, letters and digits only.
fn normalize(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// The server's own name: without Claude's `claude_ai_` prefix, and for a plugin
/// (`plugin_<plugin>_<server>`) without the plugin part.
fn server_key(server: &str) -> String {
    let name = server.strip_prefix("claude_ai_").unwrap_or(server);
    match name.strip_prefix("plugin_") {
        Some(rest) => rest.split_once('_').map_or(rest, |(_, server)| server).to_string(),
        None => name.to_string(),
    }
}

/// The domain of a well-known connector.
fn known_domain(server: &str) -> Option<&'static str> {
    Some(match normalize(&server_key(server)).as_str() {
        "notion" => "notion.com",
        "gmail" => "mail.google.com",
        "googlecalendar" => "calendar.google.com",
        "googledrive" => "drive.google.com",
        "slack" => "slack.com",
        "linear" => "linear.app",
        "figma" => "figma.com",
        "github" => "github.com",
        "gitlab" => "gitlab.com",
        "atlassian" | "jira" | "confluence" => "atlassian.com",
        "wordpresscom" | "wordpress" => "wordpress.com",
        "strava" => "strava.com",
        "intercom" => "intercom.com",
        "asana" => "asana.com",
        "canva" => "canva.com",
        "stripe" => "stripe.com",
        "sentry" => "sentry.io",
        "vercel" => "vercel.com",
        "supabase" => "supabase.com",
        "cloudflare" => "cloudflare.com",
        "hubspot" => "hubspot.com",
        "zapier" => "zapier.com",
        "playwright" => "playwright.dev",
        "context7" => "context7.com",
        "claudedocs" => "claude.ai",
        "paypal" => "paypal.com",
        "box" => "box.com",
        "dropbox" => "dropbox.com",
        "airtable" => "airtable.com",
        "monday" => "monday.com",
        "todoist" => "todoist.com",
        "clickup" => "clickup.com",
        "miro" => "miro.com",
        "huggingface" => "huggingface.co",
        "netlify" => "netlify.com",
        "shopify" => "shopify.com",
        "square" => "squareup.com",
        "plaid" => "plaid.com",
        "postman" => "postman.com",
        "docker" => "docker.com",
        "mongodb" => "mongodb.com",
        "neon" => "neon.tech",
        "firebase" => "firebase.google.com",
        "trello" => "trello.com",
        _ => return None,
    })
}

/// The site behind an http(s) URL: its host without the port and without a
/// leading `mcp.` / `api.` style label. None for local and IP hosts.
fn domain_of_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') { authority } else { authority.split(':').next().unwrap_or("") };
    let host = host.to_ascii_lowercase();
    let bare = host.trim_matches(['[', ']']);
    if bare.is_empty()
        || bare == "localhost"
        || bare.ends_with(".localhost")
        || bare.ends_with(".local")
        || bare.ends_with(".internal")
        || bare.parse::<std::net::IpAddr>().is_ok()
    {
        return None;
    }
    let mut labels: Vec<&str> = bare.split('.').collect();
    if labels.len() >= 3 && ["mcp", "api", "server", "sse", "remote", "gateway"].contains(&labels[0]) {
        labels.remove(0);
    }
    Some(labels.join("."))
}

/// The domain of a server the chat's agent has configured with a URL.
fn configured_domain(app: &tauri::AppHandle, chat_id: &str, server: &str) -> Option<String> {
    let chat = app.state::<crate::chat::ChatState>().list().into_iter().find(|c| c.chat_id == chat_id)?;
    // The configs of a chat in WSL live in the distro.
    if chat.wsl_distro.is_some() {
        return None;
    }
    let tools = crate::agent_insight::read_tools(app, &chat.agent, &chat.cwd, chat.profile).ok()?;
    // Claude replaces what isn't a letter, digit, `_` or `-` in a name when it builds tool ids.
    let sanitize = |n: &str| n.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect::<String>();
    let found = tools.mcp.iter().find(|m| m.name == server).or_else(|| tools.mcp.iter().find(|m| sanitize(&m.name) == server))?;
    if found.transport == "stdio" {
        return None;
    }
    domain_of_url(&found.target)
}

static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<String>)>>> = OnceLock::new();

/// The icon (a `data:` URI) of the MCP server `server`, from the cache while it
/// is fresh. Blocking.
pub(crate) fn icon(app: &tauri::AppHandle, chat_id: Option<&str>, server: &str) -> Option<String> {
    if server.len() > MAX_SERVER_LEN {
        return None;
    }
    let domain = chat_id.and_then(|id| configured_domain(app, id, server)).or_else(|| known_domain(server).map(str::to_string))?;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, icon)) = lock(cache).get(&domain) {
        let ttl = if icon.is_some() { CACHE_TTL } else { CACHE_FAIL_TTL };
        if at.elapsed() < ttl {
            return icon.clone();
        }
    }
    let icon = crate::link_preview::site_icon(&domain);
    let mut cache = lock(cache);
    if cache.len() >= CACHE_ENTRIES && !cache.contains_key(&domain) {
        if let Some(oldest) = cache.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(domain, (Instant::now(), icon.clone()));
    icon
}

/// The icon of an MCP server named in a chat's tool calls.
#[tauri::command]
pub async fn mcp_icon(app: tauri::AppHandle, chat_id: Option<String>, server: String) -> Option<String> {
    crate::blocking(move || Ok(icon(&app, chat_id.as_deref(), &server))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_servers() {
        assert_eq!(server_key("claude_ai_Notion"), "Notion");
        assert_eq!(server_key("plugin_playwright_playwright"), "playwright");
        assert_eq!(known_domain("claude_ai_Notion"), Some("notion.com"));
        assert_eq!(known_domain("claude_ai_WordPress_com"), Some("wordpress.com"));
        assert_eq!(known_domain("plugin_playwright_playwright"), Some("playwright.dev"));
        assert_eq!(known_domain("flowcode"), None);
    }

    #[test]
    fn domains_of_urls() {
        let d = |u: &str| domain_of_url(u);
        assert_eq!(d("https://mcp.notion.com/mcp").as_deref(), Some("notion.com"));
        assert_eq!(d("https://mcp.linear.app/sse").as_deref(), Some("linear.app"));
        assert_eq!(d("https://api.githubcopilot.com/mcp/").as_deref(), Some("githubcopilot.com"));
        assert_eq!(d("https://example.com:8443/x").as_deref(), Some("example.com"));
        assert_eq!(d("http://localhost:3000"), None);
        assert_eq!(d("http://127.0.0.1/x"), None);
        assert_eq!(d("stdio-cmd"), None);
    }
}
