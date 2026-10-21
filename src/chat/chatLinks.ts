/** Web links in the text an agent wrote. Shared by the desktop chat and the
 * phone's (mobile/src/ChatBody.tsx), so both find the same ones. */

/** A markdown `[text](url)` (one level of parentheses allowed in the url), or a bare url. */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)|https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}]/;
/** Longest url handed to the opener or the preview fetch. */
const MAX_URL_LENGTH = 2048;

export type LinkPart = { text: string; url?: undefined } | { text: string; url: string };

/** Drops sentence punctuation stuck to a bare url, but keeps a `)` that closes a `(` inside it. */
function trimUrl(url: string): string {
  let u = url;
  while (u.length > 0 && TRAILING.test(u[u.length - 1])) {
    if (u.endsWith(")") && u.split("(").length >= u.split(")").length) break;
    u = u.slice(0, -1);
  }
  return u;
}

/** One line of text cut into plain pieces and links (`[text](url)`, or a bare http(s) url, which is its own text). */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
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
