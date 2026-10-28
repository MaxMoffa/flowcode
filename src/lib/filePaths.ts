/** File paths in free text - what an agent wrote in the chat, what a program
 * printed in a terminal - found so they can be offered as links. Detection is
 * by shape only: whether a candidate really exists is asked of the disk
 * afterwards (see `checkPath` in ./fileLinks), so this errs on the side of
 * finding a few too many (`and/or`) rather than missing real ones. */

/** Longest path detected. */
export const MAX_PATH_LENGTH = 1024;

export interface ParsedPath {
  /** The path as written, without any `:line:col` / `(line,col)` suffix or `file://` scheme. */
  path: string;
  line?: number;
  col?: number;
}

export interface PathMatch extends ParsedPath {
  /** Where the link goes in the text: `[start, end)`, the line suffix included. */
  start: number;
  end: number;
}

export interface ParseOptions {
  /** A bare file name (`useChat.ts`) counts too, when its extension is a known one - for a `code span` in the chat, not for loose prose. */
  bare?: boolean;
  /** With `bare`: a name without a known extension counts too (`src-tauri`, `LICENSE`) - for a whole `code span`, where the disk check decides. */
  bareAny?: boolean;
  /** Spaces allowed inside (the text was quoted, so they can't be separators). */
  spaces?: boolean;
}

/** Extensions a bare file name must have to be taken as one. */
const KNOWN_EXT = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc json5 md mdx txt log csv tsv yml yaml toml ini cfg conf env xml html htm css scss sass less " +
    "rs go py rb php java kt kts swift c h cc cpp cxx hpp hh cs fs vb lua pl r dart scala sql graphql gql proto " +
    "sh bash zsh fish ps1 psm1 bat cmd vue svelte astro lock gradle properties tf hcl dockerfile makefile " +
    "png jpg jpeg gif svg webp ico bmp pdf zip tar gz tgz 7z wasm exe dll msi"
  ).split(" "),
);

/** Opening one of these with the OS default app would run it: never offered for a path link. Mirrors
 * `DENIED_OPEN_EXT` in src-tauri/src/system.rs, which is authoritative (it refuses the open itself) - a
 * Rust test fails when the two drift apart. */
const EXECUTABLE_EXT = new Set(
  (
    "exe com bat cmd ps1 psm1 psd1 ps1xml vbs vbe vb js jse mjs cjs wsf wsh ws wsc sct hta msi msp mst scr lnk url website " +
    "cpl reg jar jnlp appref-ms application xbap app command sh bash zsh fish ksh csh pif inf ins isp scf gadget msc chm xll " +
    "py pyw pyc pyz pl rb php appx msix appxbundle msixbundle appinstaller diagcab vsix mdb accde accdb ade adp " +
    "library-ms searchconnector-ms settingcontent-ms iso img vhd vhdx desktop appimage run bin deb rpm pkg dmg apk tool workflow"
  ).split(" "),
);

const LEADING = /[([{*]/;
const TRAILING = /[.,;:!?)\]}>]/;
/** Characters that end an unquoted token. */
const DELIMITER = /[\s"'`<>|]/;

const isDrivePath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);
/** Only the WSL shares: any other `\\server\` makes Windows authenticate to that server (NTLM) just to check
 * the link exists, and `\\.\` / `\\?\` reach devices and named pipes. The backend refuses them too. */
const isUncPath = (p: string) => /^\\\\(?:wsl\.localhost|wsl\$)[\\/][^\\/\s]/i.test(p);
const isPosixAbsolute = (p: string) => /^\/[^/\s]/.test(p);

/** Lower-cased extension of the last segment, "" when there is none. */
function extension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether opening `path` with the OS default app would run code (by extension). */
export function isExecutablePath(path: string): boolean {
  // Windows drops a trailing dot or space when opening: `run.exe.` is `run.exe`.
  if (/[. ]$/.test(path)) return true;
  return EXECUTABLE_EXT.has(extension(path));
}

/** A long path cut down for a menu header, keeping its end (the file name). */
export function shortenPath(path: string, max = 60): string {
  return path.length > max ? `…${path.slice(-(max - 1))}` : path;
}

/** One candidate taken as a whole: the path it names (and line/column), or null when it doesn't look like one. */
export function parsePathToken(raw: string, opts: ParseOptions = {}): ParsedPath | null {
  if (!raw || raw.length > MAX_PATH_LENGTH || raw.includes("\0") || /[\r\n\t]/.test(raw)) return null;
  if (raw.trim() !== raw || (!opts.spaces && /\s/.test(raw))) return null;
  let s = raw;
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(?:localhost)?/i, "");
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
    if (s.includes("\0")) return null;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s) || /^(?:mailto|data|javascript|about|tel|blob):/i.test(s)) {
    // A url: web links have their own handling.
    return null;
  }
  let base = s;
  let line: number | undefined;
  let col: number | undefined;
  const suffix = /^(.+?)(?::(\d{1,7})(?::(\d{1,7}))?|\((\d{1,7})(?:,\s?(\d{1,7}))?\))$/.exec(s);
  if (suffix) {
    base = suffix[1];
    const l = suffix[2] ?? suffix[4];
    const c = suffix[3] ?? suffix[5];
    line = Number(l);
    if (c !== undefined) col = Number(c);
  }
  // Glob/redirection/quote characters: never part of a path we offer.
  if (/[<>|*?"]/.test(base)) return null;
  // A colon only right after a drive letter (`host:path`, `node:fs` are not local paths).
  if (base.slice(isDrivePath(base) ? 2 : 0).includes(":")) return null;
  let ok: boolean;
  if (isDrivePath(base) || isUncPath(base) || isPosixAbsolute(base)) ok = true;
  else if (/^~[\\/][^\\/]/.test(base)) ok = true;
  else if (/^\.{1,2}[\\/][^\\/]/.test(base)) ok = true;
  else if (/^[^\\/]+[\\/]$/.test(base)) {
    // `src/`: one folder, written as one.
    ok = /[A-Za-z]/.test(base) && !base.startsWith("-");
  } else if (/^[^\\/]+(?:[\\/][^\\/]+)+[\\/]?$/.test(base)) {
    // `1/2`, `12/05/2024`: numbers, not paths.
    ok = /[A-Za-z]/.test(base) && !base.startsWith("-");
  } else if (opts.bare && /^[\w@+-][\w.@+-]*$/.test(base)) {
    const ext = extension(base);
    ok =
      KNOWN_EXT.has(ext) ||
      (base.length > 1 && KNOWN_EXT.has(base.toLowerCase())) ||
      (!!opts.bareAny && base.length > 1 && /[A-Za-z]/.test(base) && !base.startsWith("-"));
  } else ok = false;
  if (!ok) return null;
  return line !== undefined ? (col !== undefined ? { path: base, line, col } : { path: base, line }) : { path: base };
}

/** Drops sentence punctuation stuck to the end of a token, but keeps a `)` that closes a `(` inside it. */
function trimEnd(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && TRAILING.test(text[e - 1])) {
    if (text[e - 1] === ")") {
      const token = text.slice(start, e);
      if (token.split("(").length >= token.split(")").length) break;
    }
    e--;
  }
  return e;
}

/** Every path-looking piece of one text (bare file names excluded - see `ParseOptions.bare`). Quoted
 * ("..." '...' `...`) paths may contain spaces; unquoted ones stop at whitespace. */
export function findPaths(text: string, opts: Omit<ParseOptions, "spaces"> = {}): PathMatch[] {
  const out: PathMatch[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = text.indexOf(ch, i + 1);
      const newline = text.indexOf("\n", i + 1);
      // Quotes around something, not an apostrophe inside a word (`it's`).
      const opens = i === 0 || /[\s([{=:,]/.test(text[i - 1]);
      const closes = close + 1 >= text.length || /[\s)\]}.,;:!?]/.test(text[close + 1]);
      if (opens && closes && close > i + 1 && (newline === -1 || close < newline) && close - i - 1 <= MAX_PATH_LENGTH) {
        const parsed = parsePathToken(text.slice(i + 1, close), { ...opts, spaces: true });
        if (parsed) {
          out.push({ start: i + 1, end: close, ...parsed });
          i = close + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (DELIMITER.test(ch)) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && !DELIMITER.test(text[j])) j++;
    let s = i;
    // `[name](path)`: only the target.
    const md = text.slice(i, j).indexOf("](");
    if (md >= 0) s = i + md + 2;
    while (s < j && LEADING.test(text[s])) s++;
    const e = trimEnd(text, s, j);
    if (e > s && e - s <= MAX_PATH_LENGTH) {
      const parsed = parsePathToken(text.slice(s, e), opts);
      if (parsed) out.push({ start: s, end: e, ...parsed });
    }
    i = j;
  }
  return out;
}
