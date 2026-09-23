import type { Extension } from "@codemirror/state";
import { linter, type Diagnostic } from "@codemirror/lint";
import { extOf } from "../lib/path";

interface CommentStyle {
  line?: string;
  block?: [string, string];
}

const C_STYLE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "css", "scss", "less",
  "rs", "go", "java", "c", "h", "cpp", "cc", "hpp", "cs", "kt", "swift",
]);
const HASH_STYLE_EXT = new Set(["py", "sh", "bash", "zsh", "fish", "rb", "toml", "yaml", "yml"]);
const SQL_STYLE_EXT = new Set(["sql"]);

function commentStyleFor(ext: string): CommentStyle | null {
  if (C_STYLE_EXT.has(ext)) return { line: "//", block: ["/*", "*/"] };
  if (HASH_STYLE_EXT.has(ext)) return { line: "#" };
  if (SQL_STYLE_EXT.has(ext)) return { line: "--", block: ["/*", "*/"] };
  return null;
}

/** Flags unbalanced/unclosed (), [], {} - skipping over strings and
 * comments (per the format's own conventions) so this stays low-noise. */
function bracketDiagnostics(text: string, style: CommentStyle): Diagnostic[] {
  const closerFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const openers = new Set(["(", "[", "{"]);
  const stack: { ch: string; pos: number }[] = [];
  const diagnostics: Diagnostic[] = [];
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const two = text.slice(i, i + 2);

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (style.block && two === style.block[1]) {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (style.line && text.startsWith(style.line, i)) {
      inLineComment = true;
      i += style.line.length - 1;
      continue;
    }
    if (style.block && two === style.block[0]) {
      inBlockComment = true;
      i++;
      continue;
    }
    if (openers.has(ch)) {
      stack.push({ ch, pos: i });
      continue;
    }
    if (ch in closerFor) {
      const top = stack.pop();
      if (!top || top.ch !== closerFor[ch]) {
        diagnostics.push({ from: i, to: i + 1, severity: "error", message: `"${ch}" senza apertura corrispondente` });
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      from: unclosed.pos,
      to: unclosed.pos + 1,
      severity: "error",
      message: `"${unclosed.ch}" non è mai stato chiuso`,
    });
  }
  return diagnostics;
}

function jsonDiagnostics(text: string): Diagnostic[] {
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const match = message.match(/position (\d+)/);
    const from = match ? Math.min(Number(match[1]), text.length) : text.length;
    const to = Math.min(text.length, from + 1);
    return [{ from, to: Math.max(from, to), severity: "error", message }];
  }
}

function yamlTabDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const leading = line.match(/^[ \t]*/)?.[0] ?? "";
    if (leading.includes("\t")) {
      diagnostics.push({
        from: offset,
        to: offset + leading.length,
        severity: "error",
        message: "YAML non permette il carattere di tabulazione per l'indentazione",
      });
    }
    offset += line.length + 1;
  }
  return diagnostics;
}

/** Lightweight, dependency-free diagnostics tailored to the file's format -
 * not a full parser/compiler, just the cheap high-value checks (JSON
 * validity, bracket balance, YAML tabs) that catch common typos. */
export function buildLinter(name: string): Extension {
  const ext = extOf(name);
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      if (ext === "json") return jsonDiagnostics(text);
      const diagnostics: Diagnostic[] = [];
      const style = commentStyleFor(ext);
      if (style) diagnostics.push(...bracketDiagnostics(text, style));
      if (ext === "yaml" || ext === "yml") diagnostics.push(...yamlTabDiagnostics(text));
      return diagnostics;
    },
    { delay: 300 },
  );
}
