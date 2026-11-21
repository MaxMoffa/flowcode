#!/usr/bin/env node
// Builds the site's changelog from the GitHub releases of MaxMoffa/flowcode:
//   site/changelog.html          the list, one card per release
//   site/releases/<tag>.html     one page per release, notes rendered in full
// Both are generated (gitignored) and wrapped in scripts/site-templates/page.html.
// No dependencies: Node 20+, built-in fetch. GITHUB_TOKEN is used when set
// (CI); unauthenticated works for local previews (60 requests/hour).
//
//   node scripts/site-releases.mjs
//
// Env: GITHUB_TOKEN (optional), SITE_URL (absolute base for og:image and
// canonical links, default https://maxmoffa.github.io/flowcode),
// RELEASES_REPO (default MaxMoffa/flowcode).
//
// Cover artwork: site/assets/releases/<tag>.{svg,webp,png,jpg}, else
// site/assets/releases/generic.svg.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT_DIR = join(SITE, "releases");
const TEMPLATE = readFileSync(join(ROOT, "scripts", "site-templates", "page.html"), "utf8").replace(/<!--[\s\S]*?-->\n/, "");
const REPO = process.env.RELEASES_REPO || "MaxMoffa/flowcode";
const SITE_URL = (process.env.SITE_URL || "https://maxmoffa.github.io/flowcode").replace(/\/+$/, "");
const COVER_EXTS = ["svg", "webp", "png", "jpg"];
const IMAGE_HOSTS = /^https:\/\/(github\.com|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|avatars\.githubusercontent\.com)\//i;

/* ------------------------------------------------------------------ fetch */

async function fetchReleases() {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "flowcode-site" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all
    .filter((r) => !r.draft && !r.prerelease && /^[\w.-]{1,40}$/.test(r.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

/* ------------------------------------------------------------------ markdown (small and safe) */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

/** Inline markdown on raw text: code spans, images (GitHub-hosted only),
 * links and bare URLs (http/https only), bold, italic, strikethrough and
 * <kbd>. Everything else is escaped. */
function inline(raw) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = raw.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = s.replace(/<kbd>([^<]{1,40})<\/kbd>/gi, (_, k) => hold(`<kbd>${esc(k)}</kbd>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
    const u = safeUrl(url);
    if (u && IMAGE_HOSTS.test(u)) return hold(`<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy">`);
    return hold(esc(alt));
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) => {
    const u = safeUrl(url);
    return u ? hold(`<a href="${esc(u)}">${inlineText(text)}</a>`) : hold(inlineText(text));
  });
  s = s.replace(/<?(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])>?/g, (m, url) => hold(`<a href="${esc(url)}">${esc(shortUrl(url))}</a>`));
  s = esc(s);
  s = emphasis(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}
/** Link text: emphasis only (no nested links). */
function inlineText(raw) {
  const keep = [];
  let s = raw.replace(/`([^`]+)`/g, (_, code) => `\u0000${keep.push(`<code>${esc(code)}</code>`) - 1}\u0000`);
  return emphasis(esc(s)).replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}
function shortUrl(url) {
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/(.+)$/.exec(url);
  return m ? m[1] : url.replace(/^https?:\/\//, "");
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Block markdown: headings, paragraphs, fenced code, lists (nested by
 * indentation), blockquotes, horizontal rules. */
function markdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1].length + 1); // the page's h1 is the release title
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const block = [];
      while (i < lines.length && (lines[i].trim() === "" ? i + 1 < lines.length && (LIST_RE.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1])) : LIST_RE.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) block.push(lines[i++]);
      out.push(list(block));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
function list(lines) {
  const items = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = LIST_RE.exec(l);
    const indent = (m ? m[1] : /^\s*/.exec(l)[0]).replace(/\t/g, "    ").length;
    if (m) items.push({ indent, ordered: /\d/.test(m[2]), text: m[3] });
    else if (items.length) items[items.length - 1].text += " " + l.trim();
  }
  let pos = 0;
  function build(level) {
    const ordered = items[pos].ordered;
    let html = ordered ? "<ol>" : "<ul>";
    while (pos < items.length && items[pos].indent >= level) {
      const it = items[pos++];
      html += `<li>${inline(it.text)}`;
      if (pos < items.length && items[pos].indent > it.indent) html += build(items[pos].indent);
      html += "</li>";
    }
    return html + (ordered ? "</ol>" : "</ul>");
  }
  let html = "";
  while (pos < items.length) html += build(items[pos].indent);
  return html;
}

/* ------------------------------------------------------------------ release model */

/** English part of the notes: older releases carry an Italian copy after a
 * `---` rule. The leading `## heading` repeats the title and is dropped. */
function notesOf(r) {
  let body = (r.body || "").replace(/\r\n?/g, "\n");
  body = body.split(/\n\s*---\s*\n/)[0];
  const lead = /^\s*##\s+(.*)\n/.exec(body);
  const heading = lead ? lead[1].trim() : "";
  if (lead) body = body.slice(lead[0].length);
  return { heading, body: body.trim() };
}
function plain(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?kbd>/gi, "")
    .replace(/[*_`~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/** The excerpt: the intro paragraph, or the first list items when there's none. */
function excerptOf(body, max = 190) {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const intro = blocks.find((b) => !/^(#|[-*+]\s|\d+\.\s|```)/.test(b));
  let text = intro ? plain(intro) : plain(body.split("\n").filter((l) => LIST_RE.test(l)).slice(0, 3).map((l) => LIST_RE.exec(l)[3]).join(" · "));
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return text;
}
function titleOf(r, heading) {
  const name = (r.name || "").trim();
  const dash = name.split(/\s+[—–-]\s+/);
  if (dash.length > 1) return dash.slice(1).join(" — ");
  if (heading) return heading.replace(/^[^\p{L}\p{N}]+/u, "");
  return name || r.tag_name;
}
function emojiOf(heading) {
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u.exec(heading || "");
  return m ? m[1] : "";
}
function coverOf(tag) {
  for (const ext of COVER_EXTS) if (existsSync(join(SITE, "assets", "releases", `${tag}.${ext}`))) return `assets/releases/${tag}.${ext}`;
  return "assets/releases/generic.svg";
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function model(r) {
  const { heading, body } = notesOf(r);
  const version = r.tag_name.replace(/^v/, "");
  return {
    tag: r.tag_name,
    version,
    title: titleOf(r, heading),
    emoji: emojiOf(heading),
    date: r.published_at,
    excerpt: excerptOf(body),
    html: markdown(body),
    cover: coverOf(r.tag_name),
    githubUrl: safeUrl(r.html_url) || `https://github.com/${REPO}/releases/tag/${encodeURIComponent(r.tag_name)}`,
  };
}

/* ------------------------------------------------------------------ pages */

function page({ root, title, description, ogType, ogImage, url, main }) {
  const vals = { root, title: esc(title), description: esc(description), ogType, ogImage: esc(ogImage), url: esc(url), main };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
}

const ARROW_L = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
const ARROW_R = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M6.5 10.5L12 16l5.5-5.5M5 20h14"/></svg>';

function card(m, i) {
  const latest = i === 0;
  return `<li class="rel-card${latest ? " is-latest reveal" : " reveal"}">
  <a href="releases/${esc(m.tag)}.html">
    <span class="rel-cover"><img src="${esc(m.cover)}" alt="" loading="${i < 4 ? "eager" : "lazy"}" width="1600" height="900"></span>
    <span class="rel-body">
      <span class="rel-meta"><b>v${esc(m.version)}</b><time datetime="${esc(m.date)}">${esc(fmtDate(m.date))}</time>${latest ? '<span class="rel-latest">Latest</span>' : ""}</span>
      <span class="rel-title">${m.emoji ? `<span class="rel-emoji" aria-hidden="true">${m.emoji}</span>` : ""}${esc(m.title)}</span>
      <span class="rel-excerpt">${esc(m.excerpt)}</span>
      <span class="rel-more">Read the notes ${ARROW_R}</span>
    </span>
  </a>
</li>`;
}

function listPage(models) {
  const main = `<section class="page-head">
  <div class="wrap">
    <span class="eyebrow">Changelog</span>
    <h1>Ripples from<br>every release.</h1>
    <p class="lead">What changed in each version of Flowcode, newest first. The same notes live on <a href="https://github.com/${REPO}/releases">GitHub Releases</a>.</p>
    <ol class="rel-grid">
${models.map(card).join("\n")}
    </ol>
  </div>
</section>`;
  const latest = models[0];
  return page({
    root: "",
    title: "Changelog · Flowcode",
    description: "Every Flowcode release, newest first: new features, improvements and bug fixes.",
    ogType: "website",
    ogImage: `${SITE_URL}/${latest ? latest.cover : "assets/releases/generic.svg"}`,
    url: `${SITE_URL}/changelog.html`,
    main,
  });
}

function neighbour(m, dir) {
  if (!m) return `<span class="rel-step is-empty"></span>`;
  return `<a class="rel-step is-${dir}" href="${esc(m.tag)}.html">
  <span class="rel-step-dir">${dir === "prev" ? ARROW_L + "Older" : "Newer" + ARROW_R}</span>
  <b>v${esc(m.version)} · ${esc(m.title)}</b>
</a>`;
}

function releasePage(m, older, newer, latest) {
  const main = `<article class="rel-page">
  <div class="wrap rel-wrap">
    <a class="rel-back" href="../changelog.html">${ARROW_L}All releases</a>
    <figure class="rel-hero"><img src="../${esc(m.cover)}" alt="" width="1600" height="900"></figure>
    <header class="rel-head">
      <span class="eyebrow">Flowcode ${esc(m.version)} · <time datetime="${esc(m.date)}">${esc(fmtDate(m.date))}</time>${latest ? " · Latest" : ""}</span>
      <h1>${m.emoji ? `<span class="rel-emoji" aria-hidden="true">${m.emoji}</span>` : ""}${esc(m.title)}</h1>
      <div class="rel-actions">
        <a class="btn btn-primary btn-sm" href="${esc(m.githubUrl)}">${DOWNLOAD}Downloads on GitHub</a>
        <a class="btn btn-ghost btn-sm" href="../download.html">Install guide</a>
      </div>
    </header>
    <div class="prose">
${m.html}
    </div>
    <nav class="rel-steps" aria-label="Other releases">
      ${neighbour(older, "prev")}
      ${neighbour(newer, "next")}
    </nav>
  </div>
</article>`;
  return page({
    root: "../",
    title: `Flowcode ${m.version} — ${m.title}`,
    description: m.excerpt || `What changed in Flowcode ${m.version}.`,
    ogType: "article",
    ogImage: `${SITE_URL}/${m.cover}`,
    url: `${SITE_URL}/releases/${encodeURIComponent(m.tag)}.html`,
    main,
  });
}

/* ------------------------------------------------------------------ main */

const releases = await fetchReleases();
if (!releases.length) throw new Error(`No published releases found for ${REPO}.`);
const models = releases.map(model);
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
models.forEach((m, i) => {
  writeFileSync(join(OUT_DIR, `${m.tag}.html`), releasePage(m, models[i + 1], models[i - 1], i === 0));
});
writeFileSync(join(SITE, "changelog.html"), listPage(models));
const custom = models.filter((m) => !m.cover.endsWith("generic.svg")).length;
console.log(`site-releases: ${models.length} releases (${custom} with their own cover) -> site/changelog.html, site/releases/`);
