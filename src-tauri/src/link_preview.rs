//! Link previews for the chat: the title, description and cover image of a web
//! page, read from its Open Graph / Twitter card tags.
//!
//! The URL comes from text an agent wrote, so every request is treated as
//! hostile: only http(s), and a host that resolves to a loopback, private or
//! otherwise internal address is refused on every redirect hop. The check lives
//! in the resolver ureq connects through, so the address that was validated is
//! the one that gets connected to (no DNS-rebinding window in between).

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;

use crate::util::lock;

/// Longest URL asked for.
const MAX_URL_LEN: usize = 2048;
/// Total time one request (all its redirect hops) may take.
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REDIRECTS: usize = 3;
/// Bytes of HTML read: the tags that matter are in the head.
const MAX_HTML_BYTES: usize = 512 * 1024;
/// Largest cover image or favicon.
const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Flowcode link preview)";
/// Previews kept, and for how long (a failure is kept for less, so a page that
/// was down is tried again soon).
const CACHE_ENTRIES: usize = 200;
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const CACHE_FAIL_TTL: Duration = Duration::from_secs(5 * 60);
const TITLE_CHARS: usize = 200;
const DESCRIPTION_CHARS: usize = 300;
const SITE_CHARS: usize = 80;

const HTML_TYPES: &[&str] = &["text/html", "application/xhtml+xml"];
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
/// What a favicon may also be (the one format sites still ship it in).
const ICON_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"];

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub final_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    /// The cover image as a `data:` URI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// The site's icon as a `data:` URI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

/// Whether an address is one a link preview may connect to: anything that is
/// not on the public internet (loopback, private, link-local, shared, unique
/// local, multicast, unspecified, reserved, or an IPv4 address wrapped in IPv6)
/// is not.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // 100.64.0.0/10, carrier-grade NAT.
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24, IETF protocol assignments.
        || (a == 192 && b == 0 && c == 0)
        // 198.18.0.0/15, benchmarking.
        || (a == 198 && (b == 18 || b == 19))
        // 240.0.0.0/4, reserved.
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    // An IPv4 address carried by a transition prefix: NAT64 (64:ff9b::/96,
    // ::/96) and 6to4 (2002::/16).
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] || s[..6] == [0; 6] {
        return is_public_v4(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return is_public_v4(embedded(s[1], s[2]));
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fe80::/10, link-local.
        || (s[0] & 0xffc0) == 0xfe80
        // fc00::/7, unique local.
        || (s[0] & 0xfe00) == 0xfc00
        // 2001:db8::/32, documentation.
        || (s[0] == 0x2001 && s[1] == 0x0db8))
}

/// Names that are local whatever they resolve to.
fn is_local_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal")
}

/// ureq's resolver: refuses a host that is, or resolves to, anything internal.
struct PublicOnly;

impl ureq::Resolver for PublicOnly {
    fn resolve(&self, netloc: &str) -> io::Result<Vec<SocketAddr>> {
        let refused = || io::Error::new(io::ErrorKind::PermissionDenied, "address not allowed");
        let host = netloc.rsplit_once(':').map_or(netloc, |(host, _)| host).trim_start_matches('[').trim_end_matches(']');
        if is_local_name(host) {
            return Err(refused());
        }
        let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
            return Err(refused());
        }
        Ok(addrs)
    }
}

/// The parts of an http(s) URL: (scheme, authority, path with query).
fn split_url(url: &str) -> Option<(&str, &str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.is_empty() {
        return None;
    }
    Some((scheme, authority, tail))
}

/// `href` as an absolute http(s) URL against `base` (no fragment), or None.
fn join_url(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    let (scheme, authority, tail) = split_url(base)?;
    let joined = if href.contains("://") {
        href.to_string()
    } else if let Some(rest) = href.strip_prefix("//") {
        format!("{scheme}://{rest}")
    } else if href.starts_with('/') {
        format!("{scheme}://{authority}{href}")
    } else if href.is_empty() || href.starts_with(['#', '?']) || href.split(['/', '?', '#']).next().is_some_and(|first| first.contains(':')) {
        // A fragment, a query, or a "data:" / "mailto:" style reference.
        return None;
    } else {
        let path = tail.split(['?', '#']).next().unwrap_or("");
        let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
        let dir = if dir.is_empty() { "/" } else { dir };
        format!("{scheme}://{authority}{dir}{href}")
    };
    let joined = joined.split('#').next().unwrap_or("").to_string();
    (split_url(&joined).is_some() && joined.len() <= MAX_URL_LEN).then_some(joined)
}

struct Fetched {
    final_url: String,
    content_type: String,
    body: Vec<u8>,
}

/// GETs `url`, following up to `MAX_REDIRECTS` redirects by hand so that each
/// hop goes through the resolver's check. A body is accepted only if its
/// content type is one of `types`; one larger than `max` is cut (`truncate`) or
/// refused.
fn fetch(url: &str, accept: &str, types: &[&str], max: usize, truncate: bool) -> Result<Fetched, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).resolver(PublicOnly).user_agent(USER_AGENT).build();
    let deadline = Instant::now() + TIMEOUT;
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        if split_url(&url).is_none() {
            return Err("not a web link".into());
        }
        let left = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()).ok_or("timed out")?;
        let response = agent.get(&url).set("Accept", accept).timeout(left).call().map_err(|e| e.to_string())?;
        if (300..400).contains(&response.status()) {
            let location = response.header("Location").ok_or("redirect without a location")?;
            url = join_url(&url, location).ok_or("bad redirect")?;
            continue;
        }
        let content_type = response.header("Content-Type").unwrap_or("").to_ascii_lowercase();
        let content_type = content_type.split(';').next().unwrap_or("").trim().to_string();
        if !types.contains(&content_type.as_str()) {
            return Err(format!("unsupported content type {content_type}"));
        }
        if !truncate && response.header("Content-Length").and_then(|l| l.parse::<usize>().ok()).is_some_and(|l| l > max) {
            return Err("too large".into());
        }
        let mut body = Vec::new();
        response.into_reader().take(max as u64 + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
        if body.len() > max {
            if !truncate {
                return Err("too large".into());
            }
            body.truncate(max);
        }
        return Ok(Fetched { final_url: url, content_type, body });
    }
    Err("too many redirects".into())
}

/// An image as a `data:` URI; None if it can't be fetched or isn't an image.
fn fetch_image(url: &str, types: &[&str]) -> Option<String> {
    let image = fetch(url, "image/*", types, MAX_IMAGE_BYTES, false).ok()?;
    if image.body.is_empty() {
        return None;
    }
    Some(format!("data:{};base64,{}", image.content_type, base64::engine::general_purpose::STANDARD.encode(image.body)))
}

/// The tags of a page's head that a preview reads.
#[derive(Debug, PartialEq)]
struct Tag {
    name: String,
    attrs: Vec<(String, String)>,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Decodes the HTML entities that turn up in titles and descriptions.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &rest[1..end];
            let ch = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                "nbsp" => ' ',
                _ => {
                    let number = name.strip_prefix('#')?;
                    let code = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => number.parse().ok()?,
                    };
                    char::from_u32(code)?
                }
            };
            Some((ch, end + 1))
        });
        match decoded {
            Some((ch, len)) => {
                out.push(ch);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Decoded, whitespace collapsed, cut to `max` characters; None if empty.
fn clean(text: &str, max: usize) -> Option<String> {
    let decoded = decode_entities(text);
    let text = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > max { format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end()) } else { text })
}

/// The `<meta>`, `<link>` and `<title>` tags before the body, tolerantly: it
/// never fails, it just reads what it can. A `<title>` carries its text as the
/// `text` attribute.
fn head_tags(html: &str) -> Vec<Tag> {
    let lower = html.to_ascii_lowercase();
    let mut tags = Vec::new();
    let mut pos = 0;
    while let Some(offset) = html[pos..].find('<') {
        let start = pos + offset;
        let rest = &html[start + 1..];
        if rest.starts_with("!--") {
            pos = lower[start..].find("-->").map_or(html.len(), |i| start + i + 3);
            continue;
        }
        let name_end = rest.find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(rest.len());
        let name = lower[start + 1..start + 1 + name_end].to_string();
        // The end of the tag: the first '>' outside quotes.
        let mut quote = None;
        let mut end = None;
        for (i, c) in rest[name_end..].char_indices() {
            match (quote, c) {
                (None, '"' | '\'') => quote = Some(c),
                (Some(q), c) if c == q => quote = None,
                (None, '>') => {
                    end = Some(start + 1 + name_end + i);
                    break;
                }
                _ => {}
            }
        }
        // A tag the page ends in the middle of is dropped.
        let Some(end) = end else { break };
        let attrs_text = &html[start + 1 + name_end..end];
        pos = end + 1;
        match name.as_str() {
            "body" | "/head" => break,
            // Their content is code, not tags.
            "script" | "style" | "noscript" => {
                let close = format!("</{name}");
                pos = lower[pos..].find(&close).map_or(html.len(), |i| pos + i);
            }
            "title" => {
                let text_end = lower[pos..].find("</title").map_or(html.len(), |i| pos + i);
                tags.push(Tag { name, attrs: vec![("text".into(), html[pos..text_end].to_string())] });
                pos = text_end;
            }
            "meta" | "link" => tags.push(Tag { name, attrs: parse_attrs(attrs_text) }),
            _ => {}
        }
    }
    tags
}

/// `name="value" other='v' bare=value flag` into lowercase-named pairs.
fn parse_attrs(text: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some(&(start, c)) = chars.peek() {
        if c.is_whitespace() || c == '/' {
            chars.next();
            continue;
        }
        let mut end = text.len();
        while let Some(&(i, c)) = chars.peek() {
            if c.is_whitespace() || c == '=' || c == '/' {
                end = i;
                break;
            }
            chars.next();
        }
        let name = text[start..end].to_ascii_lowercase();
        while chars.next_if(|&(_, c)| c.is_whitespace()).is_some() {}
        let mut value = String::new();
        if chars.next_if(|&(_, c)| c == '=').is_some() {
            while chars.next_if(|&(_, c)| c.is_whitespace()).is_some() {}
            match chars.peek().copied() {
                Some((_, q @ ('"' | '\''))) => {
                    chars.next();
                    for (_, c) in chars.by_ref() {
                        if c == q {
                            break;
                        }
                        value.push(c);
                    }
                }
                _ => {
                    while let Some((_, c)) = chars.next_if(|&(_, c)| !c.is_whitespace()) {
                        value.push(c);
                    }
                }
            }
        }
        if !name.is_empty() {
            attrs.push((name, value));
        }
    }
    attrs
}

/// What the page says about itself, before the image and icon are fetched.
#[derive(Debug, Default, PartialEq)]
struct PageInfo {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    image: Option<String>,
    icons: Vec<String>,
}

fn page_info(html: &str) -> PageInfo {
    let tags = head_tags(html);
    // The content of the first `<meta property|name=...>` among `keys`, in order of preference.
    let meta = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            tags.iter()
                .filter(|t| t.name == "meta")
                .find(|t| t.attr("property").or(t.attr("name")).is_some_and(|n| n.eq_ignore_ascii_case(key)) && t.attr("content").is_some_and(|c| !c.trim().is_empty()))
                .and_then(|t| t.attr("content"))
        })
    };
    let title_tag = tags.iter().find(|t| t.name == "title").and_then(|t| t.attr("text"));
    let mut icons: Vec<(bool, &str)> = tags
        .iter()
        .filter(|t| t.name == "link")
        .filter_map(|t| {
            let rel = t.attr("rel")?.to_ascii_lowercase();
            let href = t.attr("href")?;
            let is_icon = rel.split_whitespace().any(|r| r == "icon");
            (is_icon || rel.contains("apple-touch-icon")).then_some((!is_icon, href))
        })
        .collect();
    // A plain icon before an apple-touch one; the page's order otherwise.
    icons.sort_by_key(|(touch, _)| *touch);
    PageInfo {
        title: meta(&["og:title", "twitter:title"]).or(title_tag).and_then(|t| clean(t, TITLE_CHARS)),
        description: meta(&["og:description", "twitter:description", "description"]).and_then(|t| clean(t, DESCRIPTION_CHARS)),
        site_name: meta(&["og:site_name"]).and_then(|t| clean(t, SITE_CHARS)),
        image: meta(&["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]).map(|s| decode_entities(s.trim())),
        icons: icons.into_iter().map(|(_, href)| decode_entities(href.trim())).collect(),
    }
}

fn load(url: &str) -> Result<LinkPreview, String> {
    if url.len() > MAX_URL_LEN || split_url(url).is_none() {
        return Err("not a web link".into());
    }
    let page = fetch(url, "text/html,application/xhtml+xml", HTML_TYPES, MAX_HTML_BYTES, true)?;
    let info = page_info(&String::from_utf8_lossy(&page.body));
    if info.title.is_none() && info.description.is_none() && info.image.is_none() {
        return Err("nothing to preview".into());
    }
    let base = page.final_url.as_str();
    let image_url = info.image.as_deref().and_then(|href| join_url(base, href));
    let mut icon_urls: Vec<String> = info.icons.iter().filter_map(|href| join_url(base, href)).take(2).collect();
    if let Some((scheme, authority, _)) = split_url(base) {
        icon_urls.push(format!("{scheme}://{authority}/favicon.ico"));
    }
    // The image and the icon are independent requests.
    let (image, favicon) = std::thread::scope(|scope| {
        let image = scope.spawn(|| image_url.as_deref().and_then(|u| fetch_image(u, IMAGE_TYPES)));
        let favicon = scope.spawn(|| icon_urls.iter().find_map(|u| fetch_image(u, ICON_TYPES)));
        (image.join().ok().flatten(), favicon.join().ok().flatten())
    });
    Ok(LinkPreview { url: url.to_string(), final_url: page.final_url, title: info.title, description: info.description, site_name: info.site_name, image, favicon })
}

struct CacheEntry {
    at: Instant,
    result: Result<LinkPreview, String>,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The preview of `url`, from the cache while it is fresh.
fn preview_cached(url: &str) -> Result<LinkPreview, String> {
    if let Some(entry) = lock(cache()).get(url) {
        let ttl = if entry.result.is_ok() { CACHE_TTL } else { CACHE_FAIL_TTL };
        if entry.at.elapsed() < ttl {
            return entry.result.clone();
        }
    }
    let result = load(url);
    let mut cache = lock(cache());
    if cache.len() >= CACHE_ENTRIES && !cache.contains_key(url) {
        if let Some(oldest) = cache.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(url.to_string(), CacheEntry { at: Instant::now(), result: result.clone() });
    result
}

/// What a link in a chat looks like: its title, description and cover image.
#[tauri::command]
pub async fn link_preview(url: String) -> Result<LinkPreview, String> {
    crate::blocking(move || preview_cached(url.trim())).await
}

impl LinkPreview {
    /// The preview with its pictures dropped as far as needed for the JSON to
    /// fit in `limit` bytes (a remote frame has a ceiling).
    pub fn fit(mut self, limit: usize) -> LinkPreview {
        let size = |p: &LinkPreview| serde_json::to_string(p).map_or(usize::MAX, |s| s.len());
        if size(&self) > limit {
            self.image = None;
        }
        if size(&self) > limit {
            self.favicon = None;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn public_addresses_are_allowed() {
        for s in ["8.8.8.8", "1.1.1.1", "140.82.112.3", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(is_public_ip(ip(s)), "{s}");
        }
    }

    #[test]
    fn internal_addresses_are_refused() {
        for s in [
            "127.0.0.1", "127.1.2.3", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.255", "255.255.255.255", "192.0.0.8", "192.0.2.1", "198.18.0.1", "240.0.0.1",
            "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.0.1", "::ffff:169.254.169.254", "::10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2002:c0a8:101::1",
        ] {
            assert!(!is_public_ip(ip(s)), "{s}");
        }
    }

    #[test]
    fn mapped_public_addresses_stay_public() {
        assert!(is_public_ip(ip("::ffff:8.8.8.8")));
        assert!(is_public_ip(ip("2002:0808:0808::1")));
    }

    #[test]
    fn local_names_are_refused_by_the_resolver() {
        use ureq::Resolver;
        for host in ["localhost:80", "LOCALHOST:443", "app.localhost:80", "printer.local:80", "db.internal:5432", "127.0.0.1:80", "[::1]:80", "10.1.2.3:8080", "[::ffff:10.0.0.1]:80"] {
            assert!(PublicOnly.resolve(host).is_err(), "{host}");
        }
    }

    #[test]
    fn urls_are_split_and_joined() {
        assert_eq!(split_url("https://a.b/c?d"), Some(("https", "a.b", "/c?d")));
        assert_eq!(split_url("https://a.b"), Some(("https", "a.b", "")));
        assert_eq!(split_url("ftp://a.b"), None);
        assert_eq!(split_url("javascript:alert(1)"), None);
        assert_eq!(split_url("https:///x"), None);
        let base = "https://a.b/dir/page.html?q=1";
        assert_eq!(join_url(base, "img.png").as_deref(), Some("https://a.b/dir/img.png"));
        assert_eq!(join_url(base, "/img.png").as_deref(), Some("https://a.b/img.png"));
        assert_eq!(join_url(base, "//cdn.x/i.png#f").as_deref(), Some("https://cdn.x/i.png"));
        assert_eq!(join_url(base, "http://o.t/i.png").as_deref(), Some("http://o.t/i.png"));
        assert_eq!(join_url("https://a.b", "i.png").as_deref(), Some("https://a.b/i.png"));
        assert_eq!(join_url(base, "data:image/png;base64,AAAA"), None);
        assert_eq!(join_url(base, "ftp://a.b/x"), None);
        assert_eq!(join_url(base, ""), None);
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(decode_entities("Tom &amp; Jerry &lt;3 &#39;x&#39; &#x41; &quot;y&quot; &nbsp;z"), "Tom & Jerry <3 'x' A \"y\"  z");
        assert_eq!(decode_entities("a & b &unknown; &#zz; &"), "a & b &unknown; &#zz; &");
    }

    #[test]
    fn open_graph_beats_the_plain_tags() {
        let html = r#"<!DOCTYPE html><html><head>
            <!-- <meta property="og:title" content="commented out"> -->
            <title> Plain   title </title>
            <meta name="description" content="Plain description">
            <meta property="og:title" content="OG &amp; title">
            <meta property='og:description' content='OG description'>
            <meta property="og:site_name" content="Site">
            <meta property="og:image" content="/cover.png">
            <script>var s = "<meta property='og:title' content='script'>";</script>
            <link rel="apple-touch-icon" href="/touch.png">
            <link rel="shortcut icon" href=/fav.png>
            </head><body><meta property="og:title" content="late"></body></html>"#;
        let info = page_info(html);
        assert_eq!(info.title.as_deref(), Some("OG & title"));
        assert_eq!(info.description.as_deref(), Some("OG description"));
        assert_eq!(info.site_name.as_deref(), Some("Site"));
        assert_eq!(info.image.as_deref(), Some("/cover.png"));
        assert_eq!(info.icons, vec!["/fav.png".to_string(), "/touch.png".to_string()]);
    }

    #[test]
    fn falls_back_to_the_title_tag_and_twitter_cards() {
        let info = page_info(r#"<head><TITLE>Only title</TITLE><meta name="twitter:image" content="a.png"><meta name="twitter:description" content="tw"></head>"#);
        assert_eq!(info.title.as_deref(), Some("Only title"));
        assert_eq!(info.description.as_deref(), Some("tw"));
        assert_eq!(info.image.as_deref(), Some("a.png"));
        assert_eq!(page_info("not html at all <<< & ><"), PageInfo::default());
        assert_eq!(page_info("<meta property=\"og:title\" content=\"unterminated"), PageInfo::default());
    }

    #[test]
    fn long_text_is_cut() {
        let long = "word ".repeat(100);
        let cut = clean(&long, 20).unwrap();
        assert!(cut.chars().count() <= 20 && cut.ends_with('…'));
        assert_eq!(clean("  \n ", 20), None);
    }

    #[test]
    fn refuses_what_is_not_a_public_web_page() {
        for url in ["file:///etc/passwd", "ftp://example.com", "http://localhost/", "http://127.0.0.1:8080/x", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://192.168.0.1/", "http://10.0.0.1/"] {
            assert!(load(url).is_err(), "{url}");
        }
    }

    #[test]
    fn a_preview_is_trimmed_to_fit() {
        let preview = LinkPreview {
            url: "https://a.b".into(),
            final_url: "https://a.b".into(),
            title: Some("t".into()),
            image: Some("x".repeat(1000)),
            favicon: Some("y".repeat(100)),
            ..Default::default()
        };
        assert!(preview.clone().fit(10_000).image.is_some());
        let fitted = preview.clone().fit(400);
        assert!(fitted.image.is_none() && fitted.favicon.is_some());
        let fitted = preview.fit(100);
        assert!(fitted.image.is_none() && fitted.favicon.is_none() && fitted.title.is_some());
    }

    #[test]
    fn serializes_camel_case_without_empty_fields() {
        let preview = LinkPreview { url: "https://a.b".into(), final_url: "https://a.b/".into(), site_name: Some("S".into()), ..Default::default() };
        assert_eq!(serde_json::to_value(preview).unwrap(), serde_json::json!({ "url": "https://a.b", "finalUrl": "https://a.b/", "siteName": "S" }));
    }

    /// Needs the network: `cargo test link_preview -- --ignored`.
    #[test]
    #[ignore]
    fn previews_a_real_page() {
        let preview = load("https://github.com/tauri-apps/tauri").unwrap();
        println!("{} | {:?} | {:?} | image {} | favicon {}", preview.final_url, preview.title, preview.description, preview.image.is_some(), preview.favicon.is_some());
        assert!(preview.title.is_some_and(|t| !t.is_empty()));
    }
}
