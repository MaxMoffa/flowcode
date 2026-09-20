import { invoke } from "@tauri-apps/api/core";

let cached: Promise<string | null> | null = null;

/** Memoized lookup of the machine's default WSL distro name (e.g. "Ubuntu") -
 * only needed for a bare `wsl` with no explicit `-d <name>` (see App.tsx's
 * `handleCommandLine`), since that flag already gives the name directly.
 * Fetched once per app session and reused for every tab. */
export function defaultWslDistro(): Promise<string | null> {
  if (!cached) cached = invoke<string | null>("wsl_default_distro").catch(() => null);
  return cached;
}

/** `/home/user` + "Ubuntu" -> `\\wsl.localhost\Ubuntu\home\user` - the UNC
 * path Windows Explorer (and this app's own file-listing commands) can
 * actually read, since a bare POSIX path means nothing to a Windows fs call. */
export function toWslUncPath(distro: string, posixPath: string): string {
  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

/** The reverse of `toWslUncPath` - needed when the explorer, browsing a
 * translated path, sends the user into a subfolder: that click has to `cd`
 * the *actual* WSL bash session, which only understands its own POSIX path,
 * not the UNC form this app made up for Windows' sake. `null` if `path`
 * isn't under that distro's UNC root at all. */
export function fromWslUncPath(distro: string, path: string): string | null {
  const prefix = `\\\\wsl.localhost\\${distro}`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = path.slice(prefix.length).replace(/\\/g, "/");
  return rest || "/";
}
