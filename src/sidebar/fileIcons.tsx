import type { ReactElement } from "react";

type IconDef = { svg: ReactElement; className: string };

function svg(children: ReactElement, viewBox = "0 0 24 24") {
  return (
    <svg viewBox={viewBox} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" stroke="currentColor" fill="none">
      {children}
    </svg>
  );
}

const CODE_EXT = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "cc", "h", "hpp", "rb", "php", "swift", "kt", "cs", "lua", "sql"]);
const STYLE_EXT = new Set(["css", "scss", "sass", "less"]);
const MARKUP_EXT = new Set(["html", "htm", "xml", "vue", "svelte"]);
const CONFIG_EXT = new Set(["json", "yaml", "yml", "toml", "ini", "env", "conf", "cfg"]);
const TEXT_DOC_EXT = new Set(["md", "mdx", "txt", "rst", "csv", "log"]);
const BINARY_DOC_EXT = new Set(["pdf", "doc", "docx"]);
const DOC_EXT = new Set([...TEXT_DOC_EXT, ...BINARY_DOC_EXT]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"]);
const SHELL_EXT = new Set(["sh", "bash", "zsh", "fish", "ps1"]);
const LOCK_EXT = new Set(["lock"]);
const TEXT_DOTFILES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".env"]);
const TEXT_NO_EXT_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README", "CHANGELOG", "Procfile"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Whether a file is safe to open in the built-in text editor rather than
 * handing it off to the OS default app. Conservative: unknown/no-extension
 * names (besides a short allowlist) fall back to the system opener. */
export function isLikelyTextFile(name: string): boolean {
  if (TEXT_DOTFILES.has(name) || TEXT_NO_EXT_NAMES.has(name)) return true;
  const ext = extOf(name);
  if (!ext) return false;
  if (LOCK_EXT.has(ext)) return true;
  return CODE_EXT.has(ext) || STYLE_EXT.has(ext) || MARKUP_EXT.has(ext) || CONFIG_EXT.has(ext) || SHELL_EXT.has(ext) || TEXT_DOC_EXT.has(ext);
}

function iconFor(ext: string, name: string): IconDef {
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") {
    return { className: "ft-git", svg: svg(<><circle cx="12" cy="5.5" r="2.2" /><circle cx="12" cy="18.5" r="2.2" /><circle cx="6" cy="12" r="2.2" /><path d="M8 12h4M12 7.5v3M12 13.5v3" /></>) };
  }
  if (LOCK_EXT.has(ext) || name.endsWith(".lock")) {
    return { className: "ft-config", svg: svg(<><rect x="5.5" y="10.5" width="13" height="9" rx="1.6" /><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" /></>) };
  }
  if (CODE_EXT.has(ext)) {
    return { className: "ft-code", svg: svg(<><polyline points="9 8 4.5 12 9 16" /><polyline points="15 8 19.5 12 15 16" /></>) };
  }
  if (STYLE_EXT.has(ext)) {
    return { className: "ft-style", svg: svg(<><path d="M19.5 4.5 4 10l6.5 2.5L13 19z" /><path d="M14.5 9.5 19 14" /></>) };
  }
  if (MARKUP_EXT.has(ext)) {
    return { className: "ft-markup", svg: svg(<><polyline points="8.5 7 4.5 12 8.5 17" /><polyline points="15.5 7 19.5 12 15.5 17" /><line x1="13.5" y1="6" x2="10.5" y2="18" /></>) };
  }
  if (CONFIG_EXT.has(ext)) {
    return { className: "ft-config", svg: svg(<><circle cx="12" cy="12" r="2.6" /><path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" /></>) };
  }
  if (DOC_EXT.has(ext)) {
    return { className: "ft-doc", svg: svg(<><path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="14" y2="16" /></>) };
  }
  if (IMAGE_EXT.has(ext)) {
    return { className: "ft-image", svg: svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="1.8" /><circle cx="9" cy="10" r="1.7" /><path d="M5 17.5 9.5 13l3 3 3.5-4.5 3 4" /></>) };
  }
  if (ARCHIVE_EXT.has(ext)) {
    return { className: "ft-archive", svg: svg(<><rect x="4.5" y="7.5" width="15" height="12" rx="1.4" /><path d="M4.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h12A1.5 1.5 0 0 1 19.5 6v1.5" /><line x1="12" y1="10.5" x2="12" y2="14.5" /></>) };
  }
  if (SHELL_EXT.has(ext)) {
    return { className: "ft-shell", svg: svg(<><polyline points="5 7 10 12 5 17" /><line x1="12" y1="17" x2="19" y2="17" /></>) };
  }
  return { className: "ft-generic", svg: svg(<path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" />) };
}

export function FileTypeIcon({ name }: { name: string }) {
  const { svg: icon, className } = iconFor(extOf(name), name);
  return <span className={`file-tree-icon ${className}`}>{icon}</span>;
}
