/** The light markdown of an agent's reply as a block tree plus an inline tokenizer. Pure (no React), shared by the desktop chat and the phone's renderers. */
import { readTable, type MdTable } from "./markdownTable";

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  /** A `[text](target)` as written; the renderer resolves it (web link, file link or label). */
  | { type: "link"; raw: string }
  /** A `![alt](src)` as written; the renderer resolves `src`. */
  | { type: "image"; alt: string; src: string }
  | { type: "strong" | "em" | "del"; children: Inline[] };

export interface ListItem {
  /** A task item (`- [ ]`, `- [x]`): whether it is ticked; null for a plain item. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; table: MdTable }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "hr" };

/** Deeper nesting than this is kept as plain text, so a hostile reply can't blow the stack. */
const MAX_DEPTH = 16;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|(\d{1,9})[.)])([ \t]+|$)(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;

/** Columns of leading whitespace (a tab counts 4). */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** The line without its first `cols` columns of leading whitespace. */
function strip(line: string, cols: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    if (line[i] === " ") col++;
    else if (line[i] === "\t") col += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

function fenceOf(line: string): { ch: string; len: number; lang: string; indent: number } | null {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trimStart());
  if (!m) return null;
  // ```code``` on one line is an inline code span, not a fence.
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { ch: m[1][0], len: m[1].length, lang: m[2].trim().split(/\s+/)[0] ?? "", indent: indentOf(line) };
}

interface ItemStart {
  indent: number;
  ordered: boolean;
  number: number;
  contentIndent: number;
  content: string;
}

function itemAt(line: string): ItemStart | null {
  if (HR.test(line)) return null;
  const m = ITEM.exec(line);
  if (!m) return null;
  const indent = indentOf(m[1]);
  const gap = indentOf(m[4]);
  // Five or more spaces after the marker: the content starts one space in (indented code is not supported).
  const width = gap >= 1 && gap <= 4 ? gap : 1;
  return {
    indent,
    ordered: m[3] !== undefined,
    number: m[3] !== undefined ? Number(m[3]) : 1,
    contentIndent: indent + m[2].length + width,
    content: m[5],
  };
}

/** Whether `rows[i]` opens a block of its own (so it ends the paragraph before it). */
function startsBlock(rows: string[], i: number): boolean {
  const row = rows[i];
  return (
    fenceOf(row) !== null ||
    HEADING.test(row) ||
    HR.test(row) ||
    QUOTE.test(row) ||
    itemAt(row) !== null ||
    (row.includes("|") && readTable(rows, i) !== null)
  );
}

function readList(rows: string[], start: number, depth: number): { block: Block; next: number } {
  const first = itemAt(rows[start])!;
  const items: ListItem[] = [];
  let i = start;
  while (i < rows.length) {
    const it = itemAt(rows[i]);
    if (!it || it.ordered !== first.ordered) break;
    const body = [it.content];
    let j = i + 1;
    while (j < rows.length) {
      const line = rows[j];
      if (line.trim() === "") {
        let k = j + 1;
        while (k < rows.length && rows[k].trim() === "") k++;
        // Blank lines stay in the item only when what follows is indented under it.
        if (k < rows.length && indentOf(rows[k]) >= it.contentIndent) {
          for (; j < k; j++) body.push("");
          continue;
        }
        j = k;
        break;
      }
      const indent = indentOf(line);
      if (indent <= it.indent) break;
      body.push(strip(line, Math.min(indent, it.contentIndent)));
      j++;
    }
    while (body.length > 1 && body[body.length - 1] === "") body.pop();
    const task = TASK.exec(body[0]);
    if (task) body[0] = task[2] ?? "";
    items.push({ checked: task ? task[1] !== " " : null, blocks: blocks(body, depth + 1) });
    i = j;
  }
  return { block: { type: "list", ordered: first.ordered, start: first.number, items }, next: i };
}

function blocks(rows: string[], depth: number): Block[] {
  if (depth > MAX_DEPTH) return [{ type: "paragraph", lines: rows.map((r) => r.trim()) }];
  const out: Block[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i];
    if (row.trim() === "") {
      i++;
      continue;
    }
    const fence = fenceOf(row);
    if (fence) {
      const code: string[] = [];
      for (i++; i < rows.length; i++) {
        const t = rows[i].trim();
        if (t.length >= fence.len && [...t].every((c) => c === fence.ch)) break;
        code.push(strip(rows[i], fence.indent));
      }
      i++;
      out.push({ type: "code", lang: fence.lang, text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(row);
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (HR.test(row)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(row)) {
      const inner: string[] = [];
      for (; i < rows.length; i++) {
        const m = QUOTE.exec(rows[i]);
        if (m) inner.push(m[1]);
        // Lazy continuation: a plain line right after quoted text stays in the quote.
        else if (rows[i].trim() !== "" && inner[inner.length - 1]?.trim() && !startsBlock(rows, i)) inner.push(rows[i].trim());
        else break;
      }
      out.push({ type: "blockquote", blocks: blocks(inner, depth + 1) });
      continue;
    }
    if (itemAt(row)) {
      const list = readList(rows, i, depth);
      out.push(list.block);
      i = list.next;
      continue;
    }
    const table = row.includes("|") ? readTable(rows, i) : null;
    if (table) {
      out.push({ type: "table", table: table.table });
      i = table.next;
      continue;
    }
    const lines = [row.trim()];
    for (i++; i < rows.length && rows[i].trim() !== "" && !startsBlock(rows, i); i++) lines.push(rows[i].trim());
    out.push({ type: "paragraph", lines });
  }
  return out;
}

/** The text as blocks. An unclosed fence, as the agent is still typing it, runs to the end. */
export function parseBlocks(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";
const LINK_AT = /\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))+\)/y;
/** `![alt](src)`: `src` angle-bracketed (may hold spaces) or a run without spaces (one level of parentheses); an optional ` "title"` is dropped. */
const IMAGE_AT = /!\[([^\]\n]*)\]\((?:<([^<>\n]*)>|((?:[^()\s]|\([^()\s]*\))+))(?:[ \t]+"[^"\n]*")?\)/y;
const URL_AT = /https?:\/\/[^\s<>"'`]+/y;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** Whether the backslash at `i` sits in a Windows path token (`C:\Users\me\.claude`, `\\server\share`, `.\src`, `..\x`): there it is a separator, not an escape. */
function inWinPath(s: string, i: number): boolean {
  let start = i;
  while (start > 0 && !/\s/.test(s[start - 1])) start--;
  // Through i + 1 so a leading `\\` (UNC) also matches at its first backslash.
  return /^[("'\[]?(?:[A-Za-z]:\\|\\\\|\.{1,2}\\)/.test(s.slice(start, i + 2));
}

/** Start of the backtick run closing the code span opened by `run` backticks at `i`, or -1. */
function codeClose(s: string, i: number, run: number): number {
  let j = i + run;
  while (j < s.length) {
    if (s[j] !== "`") {
      j++;
      continue;
    }
    let k = j;
    while (s[k] === "`") k++;
    if (k - j === run) return j;
    j = k;
  }
  return -1;
}

/** Where the closing `n` marks of `ch` start (searching from `from`), or -1. Skips escapes and code spans; a closer follows non-space, and a `_` one is not intraword. */
function findClose(s: string, from: number, ch: string, n: number): number {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\" && !inWinPath(s, j)) {
      j += 2;
    } else if (c === "`") {
      let run = 1;
      while (s[j + run] === "`") run++;
      const close = codeClose(s, j, run);
      j = close < 0 ? j + run : close + run;
    } else if (c === ch) {
      let run = 1;
      while (s[j + run] === ch) run++;
      // `***` closes a `*` or `**` opened before it (the last marks are the closer).
      const fits = run === n || (ch !== "~" && run === 3 && n < 3);
      if (fits && j > from && !isSpace(s[j - 1]) && (ch !== "_" || !isWord(s[j + run]))) return j + run - n;
      j += run;
    } else {
      j++;
    }
  }
  return -1;
}

/** One line of text as inline tokens: `code` (wins over everything), **bold**, *italic*, ***both***, ~~strike~~, `[text](url)` links, `![alt](src)` images and backslash escapes. A `_` inside a word (snake_case) and a `*` with spaces around it stay plain. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1]) && !inWinPath(s, i)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const close = codeClose(s, i, run);
      if (close < 0) {
        buf += "`".repeat(run);
        i += run;
        continue;
      }
      let code = s.slice(i + run, close);
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
      flush();
      out.push({ type: "code", text: code });
      i = close + run;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      IMAGE_AT.lastIndex = i;
      const m = IMAGE_AT.exec(s);
      if (m) {
        flush();
        out.push({ type: "image", alt: m[1], src: m[2] ?? m[3] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      LINK_AT.lastIndex = i;
      const m = LINK_AT.exec(s);
      if (m) {
        flush();
        out.push({ type: "link", raw: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !isWord(s[i - 1])) {
      // A bare url stays whole, so its underscores and stars are not markup.
      URL_AT.lastIndex = i;
      const m = URL_AT.exec(s);
      if (m) {
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let run = 1;
      while (s[i + run] === c) run++;
      const canOpen = c === "~" ? run === 2 : run <= 3 && (c === "*" || !isWord(s[i - 1]));
      const close = canOpen && !isSpace(s[i + run]) ? findClose(s, i + run, c, run) : -1;
      if (close >= 0) {
        flush();
        const children = parseInline(s.slice(i + run, close));
        if (c === "~") out.push({ type: "del", children });
        else if (run === 1) out.push({ type: "em", children });
        else if (run === 2) out.push({ type: "strong", children });
        else out.push({ type: "strong", children: [{ type: "em", children }] });
        i = close + run;
      } else {
        buf += c.repeat(run);
        i += run;
      }
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
