import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { go } from "@codemirror/legacy-modes/mode/go";
import { c, cpp, java, csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { extOf } from "../lib/path";


/** Best-effort CodeMirror language for a filename, by extension. Returns
 * null for formats with no available grammar (plain text, no highlighting). */
export function languageFor(name: string): Extension | null {
  if (/^dockerfile(\.\w+)?$/i.test(name)) return StreamLanguage.define(dockerFile);

  const ext = extOf(name);
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "html":
    case "htm":
      return html();
    case "xml":
    case "svg":
      return StreamLanguage.define(xml);
    case "md":
    case "mdx":
      return markdown();
    case "py":
      return python();
    case "rs":
      return rust();
    case "sql":
      return sql();
    case "yaml":
    case "yml":
      return yaml();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return StreamLanguage.define(shell);
    case "ps1":
      return StreamLanguage.define(powerShell);
    case "go":
      return StreamLanguage.define(go);
    case "c":
    case "h":
      return StreamLanguage.define(c);
    case "cpp":
    case "cc":
    case "hpp":
      return StreamLanguage.define(cpp);
    case "java":
      return StreamLanguage.define(java);
    case "cs":
      return StreamLanguage.define(csharp);
    case "kt":
      return StreamLanguage.define(kotlin);
    case "rb":
      return StreamLanguage.define(ruby);
    case "lua":
      return StreamLanguage.define(lua);
    case "toml":
      return StreamLanguage.define(toml);
    case "ini":
    case "conf":
    case "cfg":
    case "env":
      return StreamLanguage.define(properties);
    case "swift":
      return StreamLanguage.define(swift);
    default:
      return null;
  }
}
