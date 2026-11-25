// Splits a markdown text into top-level chunks that parse independently, so a streaming message re-renders only
// its last chunk (the live tail) instead of reparsing everything on every token.
const ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;

/** The text cut at blank lines that end a block. Never cut inside a fenced block or `$$`/`\[` math, and never before an indented line or a list item (both can continue the list above across the blank line). Concatenating the parse of each chunk equals the parse of the whole. */
export function splitMarkdown(text: string): string[] {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let start = -1;
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const trimmed = row.trim();
    if (fence) {
      if (trimmed.length >= fence.len && [...trimmed].every((c) => c === fence!.ch)) fence = null;
      continue;
    }
    if (trimmed === "") {
      if (start < 0) continue;
      let k = i + 1;
      while (k < rows.length && rows[k].trim() === "") k++;
      if (k >= rows.length) break;
      if (!/^[ \t]/.test(rows[k]) && !ITEM.test(rows[k])) {
        out.push(rows.slice(start, i).join("\n"));
        start = -1;
        i = k - 1;
      }
      continue;
    }
    if (start < 0) start = i;
    const f = FENCE.exec(trimmed);
    // ```code``` on one line is an inline span, not a fence (same rule as the parser).
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { ch: f[1][0], len: f[1].length };
      continue;
    }
    const close = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\[") ? "\]" : "";
    if (close && !(trimmed.length > 4 && trimmed.endsWith(close))) {
      // A multi-line math block runs to its closing line; unclosed it is a plain paragraph (nothing to skip).
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].trim().endsWith(close)) {
          i = j;
          break;
        }
      }
    }
  }
  if (start >= 0) out.push(rows.slice(start).join("\n"));
  return out;
}
