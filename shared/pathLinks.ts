// The pure part of how chat text turns into file-path links, shared by the
// desktop and phone renderers: where the paths are, and what an inline code
// span is. Each app renders the pieces with its own link component.
import { findPaths, parsePathToken, type ParsedPath, type PathMatch } from "../src/lib/filePaths";

/** A piece of text: plain, or (with `match`) a path to link; `index` counts the matches. */
export interface PathSegment {
  text: string;
  match?: PathMatch;
  index?: number;
}

/** `text` cut into plain and path pieces; `accept` drops matches the app can't open. */
export function pathSegments(text: string, opts: { bare?: boolean; accept?: (path: string) => boolean } = {}): PathSegment[] {
  const matches = findPaths(text, { bare: opts.bare ?? false }).filter((m) => !opts.accept || opts.accept(m.path));
  if (matches.length === 0) return [{ text }];
  const out: PathSegment[] = [];
  let last = 0;
  matches.forEach((m, index) => {
    if (m.start > last) out.push({ text: text.slice(last, m.start) });
    out.push({ text: text.slice(m.start, m.end), match: m, index });
    last = m.end;
  });
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** A dotted host without a scheme is not an implicit file link. `./host/path` stays explicit. */
export function looksLikeHost(path: string): boolean {
  return /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}\//i.test(path);
}

const COMMAND_PREFIX = /^(?:open|xdg-open|start|explorer(?:\.exe)?|code|cat|type|less|more|head|tail|rg|grep|ls|dir|cd|cp|mv|rm|git|npm|npx|pnpm|yarn|bun|node|python(?:3)?|cargo|go|dotnet|bash|sh|zsh|pwsh|powershell|cmd|Get-Content|Set-Content)\s+/i;

/** Whether an inline code span starts with a known command, whose path argument must not be swallowed with it. */
export function startsWithCommand(code: string): boolean {
  return COMMAND_PREFIX.test(code);
}

/** The path an inline code span is as a whole (bare names and spaces allowed), if it is one. */
export function wholeCodePath(code: string): ParsedPath | null {
  return parsePathToken(code, { bare: true, bareAny: true, spaces: true });
}
