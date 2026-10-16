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

/** A row ending this close to the right edge may have been cut there by the app rather than ended. */
const EDGE = 3;
/** How far back a tap may reach to find where a link starts. */
const MAX_ROWS = 24;
const NOT_URL = /[\s"'<>`]/;
const LEAD_PAD = /^[\s│┃║]+/;
const TAIL_PAD = /[\s│┃║]+$/;
const URL_TAIL = /https?:\/\/[^\s"'<>`]*$/i;

/**
 * The link at buffer cell (row, col). Rows xterm wrapped are joined so a long
 * URL is found whole; so are rows the app cut itself (TUIs like Claude Code
 * break a long link at their edge with a real line break): a row reaching the
 * right edge inside a link goes on in the next row, past its indent and border.
 */
export function linkAtCell(buf: LineSource, row: number, col: number, cols: number): string | null {
  if (!buf.getLine(row)) return null;
  const cutAt = (y: number) => {
    const a = buf.getLine(y);
    const b = buf.getLine(y + 1);
    if (!a || !b || b.isWrapped) return false;
    const end = a.translateToString(true).replace(TAIL_PAD, "");
    const next = b.translateToString(true).replace(LEAD_PAD, "");
    return end.length >= cols - EDGE && end !== "" && next !== "" && !NOT_URL.test(end[end.length - 1]) && !NOT_URL.test(next[0]);
  };
  let first = row;
  for (let n = 0; first > 0 && n < MAX_ROWS; n++) {
    if (buf.getLine(first)?.isWrapped || cutAt(first - 1)) first--;
    else break;
  }
  let text = "";
  let offset = -1;
  for (let y = first; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const soft = !!buf.getLine(y + 1)?.isWrapped;
    // Untrimmed while another row continues it, so every row keeps its full width.
    let part = line.translateToString(!soft);
    let lead = 0;
    if (y > first && !line.isWrapped && text !== "") {
      const s = part.replace(LEAD_PAD, "");
      lead = part.length - s.length;
      part = s;
    }
    const cut = !soft && cutAt(y) && URL_TAIL.test(text + part.replace(TAIL_PAD, ""));
    if (cut) part = part.replace(TAIL_PAD, "");
    if (y === row) {
      if (col < lead) return null;
      offset = text.length + col - lead;
    }
    text += part;
    if (!soft && !cut) {
      if (y >= row) break;
      // The row ended the line before the tapped one: start over from the next.
      text = "";
    }
  }
  return offset < 0 ? null : urlAt(text, offset);
}
