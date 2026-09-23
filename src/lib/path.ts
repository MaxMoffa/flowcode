/** Path helpers that work on every shape of path this app sees: POSIX
 * (`/home/me`), Windows drive (`C:\Users\me`) and UNC/WSL
 * (`\\wsl.localhost\Ubuntu\home\me`). Paths come straight from Rust's
 * `to_string_lossy`, so on Windows they are backslash-separated - splitting on
 * "/" alone silently breaks there. */

/** The last path segment ("file.txt" for "C:\dir\file.txt" or "/dir/file.txt"). */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed || path;
}

/** Lower-cased extension without the dot, "" when there is none (dotfiles
 * like ".gitignore" count as having no extension). */
export function extOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Separator a given path uses - sniffed from the path itself rather than the
 * host platform, since a WSL tab on Windows can report POSIX paths. */
export function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

/** Drive-letter or UNC - a path only a real Windows shell (not WSL, not a
 * POSIX host) would ever report. */
export function isWindowsHostPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** POSIX, Windows drive-letter or UNC absolute path. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsHostPath(path);
}

/** A top-level root with nowhere above it to go: "/", a bare drive ("C:" /
 * "C:\"), or a UNC share root ("\\wsl.localhost\Ubuntu"). */
export function isRootPath(path: string): boolean {
  if (!path || path === "/") return true;
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return true;
  if (path.startsWith("\\\\")) return path.slice(2).split("\\").filter(Boolean).length <= 2;
  return false;
}

/** Strips trailing separators, but never past a root ("/", "C:\"). */
export function trimTrailingSeparators(path: string): string {
  if (isRootPath(path)) return path;
  return path.replace(/[\\/]+$/, "") || path;
}

/** The containing folder, one level up - a root is its own parent. */
export function parentPath(path: string): string {
  if (isRootPath(path)) return path;
  const trimmed = trimTrailingSeparators(path);
  if (separatorOf(trimmed) === "/") {
    const idx = trimmed.lastIndexOf("/");
    return idx <= 0 ? "/" : trimmed.slice(0, idx);
  }
  if (trimmed.startsWith("\\\\")) {
    const parts = trimmed.slice(2).split("\\");
    return "\\\\" + parts.slice(0, -1).join("\\");
  }
  const driveRoot = trimmed.match(/^[A-Za-z]:\\/)?.[0];
  const idx = trimmed.lastIndexOf("\\");
  if (driveRoot && idx < driveRoot.length) return driveRoot;
  return trimmed.slice(0, idx);
}

/** Just the last two segments ("…\a\b") so deep paths fit a narrow header -
 * callers keep the full path in a tooltip. */
export function truncatePath(path: string): string {
  const sep = separatorOf(path);
  const parts = trimTrailingSeparators(path).split(sep).filter(Boolean);
  if (parts.length <= 2) return path || "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

/** `~` / `~/...` against `home` (a no-op when `home` isn't known yet). */
export function expandHome(path: string, home: string): string {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

export function isWindowsPlatform(): boolean {
  return document.documentElement.dataset.platform === "windows";
}
