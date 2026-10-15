const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const TRAILING = /[.,;:!?)\]}]/;

/** Only web links are ever opened (same rule as the desktop terminal). */
export const isWebUrl = (s: string) => /^https?:\/\//i.test(s);

/** Drops sentence punctuation stuck to the URL, but keeps a `)` that closes a `(` inside it. */
function trimUrl(url: string): string {
  let u = url;
  while (u.length > 0 && TRAILING.test(u[u.length - 1])) {
    if (u.endsWith(")") && u.split("(").length >= u.split(")").length) break;
    u = u.slice(0, -1);
  }
  return u;
}

/** The web link under character `offset` of `text`, or null. */
export function urlAt(text: string, offset: number): string | null {
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const start = m.index ?? 0;
    if (offset >= start && offset < start + url.length) return isWebUrl(url) && url.length > 8 ? url : null;
  }
  return null;
}

/** The part of xterm's buffer API the line walk needs. */
interface LineSource {
  length: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/** The link at buffer cell (row, col): wrapped rows are joined so a long URL is found whole. */
export function linkAtCell(buf: LineSource, row: number, col: number): string | null {
  if (!buf.getLine(row)) return null;
  let first = row;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let text = "";
  let offset = col;
  for (let y = first; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    const next = buf.getLine(y + 1);
    // Untrimmed while another row continues it, so every row keeps its full width.
    const part = line.translateToString(!next?.isWrapped);
    if (y < row) offset += part.length;
    text += part;
  }
  return urlAt(text, offset);
}
