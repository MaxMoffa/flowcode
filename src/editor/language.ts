import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { extOf } from "../lib/path";

/** Legacy modes share CodeMirror's stream parser, itself loaded on demand. */
function stream<State>(parser: Promise<StreamParser<State>>): Promise<Extension> {
  return parser.then((mode) => StreamLanguage.define(mode));
}

// Literal imports let Vite build a separate chunk for each requested grammar.
const loaders = {
  javascript: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true, typescript: true })),
  json: () => import("@codemirror/lang-json").then(({ json }) => json()),
  css: () => import("@codemirror/lang-css").then(({ css }) => css()),
  html: () => import("@codemirror/lang-html").then(({ html }) => html()),
  markdown: () => import("@codemirror/lang-markdown").then(({ markdown }) => markdown()),
  python: () => import("@codemirror/lang-python").then(({ python }) => python()),
  rust: () => import("@codemirror/lang-rust").then(({ rust }) => rust()),
  sql: () => import("@codemirror/lang-sql").then(({ sql }) => sql()),
  yaml: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml()),
  shell: () => stream(import("@codemirror/legacy-modes/mode/shell").then(({ shell }) => shell)),
  powershell: () => stream(import("@codemirror/legacy-modes/mode/powershell").then(({ powerShell }) => powerShell)),
  go: () => stream(import("@codemirror/legacy-modes/mode/go").then(({ go }) => go)),
  c: () => stream(import("@codemirror/legacy-modes/mode/clike").then(({ c }) => c)),
  cpp: () => stream(import("@codemirror/legacy-modes/mode/clike").then(({ cpp }) => cpp)),
  java: () => stream(import("@codemirror/legacy-modes/mode/clike").then(({ java }) => java)),
  csharp: () => stream(import("@codemirror/legacy-modes/mode/clike").then(({ csharp }) => csharp)),
  kotlin: () => stream(import("@codemirror/legacy-modes/mode/clike").then(({ kotlin }) => kotlin)),
  ruby: () => stream(import("@codemirror/legacy-modes/mode/ruby").then(({ ruby }) => ruby)),
  lua: () => stream(import("@codemirror/legacy-modes/mode/lua").then(({ lua }) => lua)),
  toml: () => stream(import("@codemirror/legacy-modes/mode/toml").then(({ toml }) => toml)),
  properties: () => stream(import("@codemirror/legacy-modes/mode/properties").then(({ properties }) => properties)),
  dockerfile: () => stream(import("@codemirror/legacy-modes/mode/dockerfile").then(({ dockerFile }) => dockerFile)),
  swift: () => stream(import("@codemirror/legacy-modes/mode/swift").then(({ swift }) => swift)),
  xml: () => stream(import("@codemirror/legacy-modes/mode/xml").then(({ xml }) => xml)),
} satisfies Record<string, () => Promise<Extension>>;

type Grammar = keyof typeof loaders;

const grammars: Record<string, Grammar> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", json: "json",
  css: "css", scss: "css", sass: "css", less: "css",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  md: "markdown", mdx: "markdown", py: "python", rs: "rust", sql: "sql",
  yaml: "yaml", yml: "yaml", sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  ps1: "powershell", go: "go", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  java: "java", cs: "csharp", kt: "kotlin", rb: "ruby", lua: "lua", toml: "toml",
  ini: "properties", conf: "properties", cfg: "properties", env: "properties", swift: "swift",
};

const cache = new Map<Grammar, Promise<Extension>>();

/** Loads only this filename's grammar. Concurrent requests share one promise;
 * failures are forgotten so a later open or rename can retry. Plain text
 * resolves to null without downloading a grammar. */
export function languageFor(name: string): Promise<Extension | null> {
  const ext = extOf(name);
  const grammar = /^dockerfile(\.\w+)?$/i.test(name) ? "dockerfile" : Object.prototype.hasOwnProperty.call(grammars, ext) ? grammars[ext] : undefined;
  if (!grammar) return Promise.resolve(null);
  const known = cache.get(grammar);
  if (known) return known;
  const pending = loaders[grammar]().catch((error: unknown) => {
    if (cache.get(grammar) === pending) cache.delete(grammar);
    throw error;
  });
  cache.set(grammar, pending);
  return pending;
}
