/** Web links in the text an agent wrote. Shared by the desktop chat and the
 * phone's (mobile/src/ChatBody.tsx), so both find the same ones. */
import type { ChatImageRef } from "./chatTypes";
import { fileUriPath } from "./chatModel";

/** A markdown `[text](url)` to the web (one level of parentheses allowed in the url), a markdown `[text](target)` to anything else (a local file, usually), or a bare url. */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)|\[([^\]\n]+)\]\(<?([^()\n<>]+?)>?\)|https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}]/;
/** Longest url handed to the opener or the preview fetch. */
const MAX_URL_LENGTH = 2048;

/** The image a markdown `![alt](src)` points at, or null when `src` is not something to fetch as an image: a web or `data:image/` url, a `file://` url, or a path (absolute, `~/`, relative) with an image extension. */
export function markdownImageRef(src: string): ChatImageRef | null {
  const t = src.trim();
  if (/^https?:\/\/[^/?#\s]+/i.test(t) || /^data:image\//i.test(t)) return { url: t };
  if (/^file:\/\//i.test(t)) return { path: fileUriPath(t) };
  if (!t || (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t))) return null;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(t.replace(/[?#].*$/, "")) ? { path: t } : null;
}

/** A plain piece, a web link, or a link to a local file (`path`: the target as written, a file:// url turned into its path). */
export type LinkPart =
  | { text: string; url?: undefined; path?: undefined }
  | { text: string; url: string; path?: undefined }
  | { text: string; path: string; url?: undefined };

/** Drops sentence punctuation stuck to a bare url, but keeps a `)` that closes a `(` inside it. */
function trimUrl(url: string): string {
  let u = url;
  while (u.length > 0 && TRAILING.test(u[u.length - 1])) {
    if (u.endsWith(")") && u.split("(").length >= u.split(")").length) break;
    u = u.slice(0, -1);
  }
  return u;
}

/** The local file a markdown link points at: a path as written, or a file:// url's path; null for an anchor or another scheme (mailto:, vscode:...). */
function localTarget(target: string): string | null {
  const t = target.trim();
  if (!t || t.startsWith("#")) return null;
  if (/^file:\/\//i.test(t)) {
    let path = t.replace(/^file:\/\//i, "");
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1);
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  // "C:/..." looks like a scheme but is a Windows drive.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return null;
  return t;
}

/** One line of text cut into plain pieces and links (`[text](url)`, or a bare http(s) url, which is its own text; `[text](path)` to a local file is a `path` link, or just its text when the target is not a file). */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    if (start > 0 && text[start - 1] === "!" && (m[1] !== undefined || m[3] !== undefined)) {
      // An image (`![alt](src)`), not a link: its alt text, plain.
      if (start > last) parts.push({ text: text.slice(last, start) });
      parts.push({ text: m[1] ?? m[3] });
      last = start + m[0].length;
      continue;
    }
    if (m[3] !== undefined) {
      // A markdown link to something not on the web: its label, linked to the file when it names one.
      const path = localTarget(m[4]);
      if (start > last) parts.push({ text: text.slice(last, start) });
      parts.push(path ? { text: m[3], path } : { text: m[3] });
      last = start + m[0].length;
      continue;
    }
    const url = m[2] ?? trimUrl(m[0]);
    // A bare url that is only a scheme, or too long, stays plain text.
    if (url.length > MAX_URL_LENGTH || !/^https?:\/\/[^/?#\s]+/i.test(url)) continue;
    const end = m[2] ? start + m[0].length : start + url.length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: m[1] ?? url, url });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The first `max` distinct links of a markdown text, outside code (fenced blocks, `spans`). An unclosed fence runs to the end. */
export function previewUrls(markdown: string, max: number): string[] {
  const urls: string[] = [];
  let fenced = false;
  for (const row of markdown.split("\n")) {
    if (row.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const part of splitLinks(row.replace(/`[^`]+`/g, " "))) {
      if (part.url && !urls.includes(part.url)) urls.push(part.url);
    }
  }
  return urls.slice(0, max);
}
