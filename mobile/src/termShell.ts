// Pure helpers for putting paths into a remote shell. Kept free of React so
// the quoting rules can be read (and tested) on their own.

export type Dialect = "posix" | "powershell";

/** A tab whose cwd has a drive letter or backslashes runs a Windows shell (PowerShell). */
export function dialectFor(cwd: string): Dialect {
  return /^[A-Za-z]:|\\/.test(cwd) ? "powershell" : "posix";
}

/** Newlines and other control characters would run as extra commands: never quoted, always refused. */
export function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s);
}

/**
 * Quotes a path for the shell, only when it would otherwise be split or expanded.
 * Returns null when the name cannot be typed safely (control characters).
 *
 *   shellQuote("src/main.rs", "posix")      -> src/main.rs
 *   shellQuote("my dir/it's", "posix")      -> 'my dir/it'\''s'
 *   shellQuote("my dir/it's", "powershell") -> 'my dir/it''s'
 *   shellQuote("a$b", "powershell")         -> 'a$b'
 *   shellQuote("a\nb", "posix")             -> null
 */
export function shellQuote(p: string, dialect: Dialect): string | null {
  if (hasControlChars(p)) return null;
  if (dialect === "powershell") {
    if (/^[\w+./-]+$/.test(p)) return p;
    // PowerShell also treats the typographic single quotes as quote characters.
    return `'${p.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
  }
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that enters a folder, typed but never run (the user confirms with Enter).
 *
 *   cdCommand("a b", "posix")       -> cd 'a b'
 *   cdCommand("a b", "powershell")  -> cd -LiteralPath 'a b'
 */
export function cdCommand(path: string, dialect: Dialect): string | null {
  const q = shellQuote(path, dialect);
  if (q === null) return null;
  return dialect === "powershell" ? `cd -LiteralPath ${q}` : `cd ${q}`;
}

/** Home prefix to `~`, so the strip stays short. (Overlaps common.tsx `shortCwd`, which is not ours to edit.) */
export function homeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/(?:home|Users)\/[^/]+/, "~");
}
