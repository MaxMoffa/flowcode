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

const homeCache = new Map<string, Promise<string | null>>();

/** Memoized lookup of the home dir of the user a WSL session runs as, keyed
 * per distro+user. Needed to expand the `~` a WSL shell's OSC title reports
 * for anything in its home tree - which is where a bare `wsl` lands, so this
 * is the common case, not an edge one (see App.tsx's `handleTitleChange`).
 * `user` is the one the title's own `user@host:` prefix names, so a session
 * entered as `wsl -u root` resolves to `/root` rather than the default
 * user's home; omitted when the title carries no prefix to read it from. */
export function wslHomeDir(distro: string, user?: string): Promise<string | null> {
  const key = `${distro}\u0000${user ?? ""}`;
  let pending = homeCache.get(key);
  if (!pending) {
    pending = invoke<string | null>("wsl_home_dir", { distro, user: user ?? null }).catch(() => null);
    homeCache.set(key, pending);
  }
  return pending;
}

/** WSL's automount root: `/mnt/c/...` isn't a Linux directory at all, it's
 * the Windows `C:` drive mounted back into the distro. Only a single-letter
 * segment counts, so real Linux mounts (`/mnt/wsl`, `/mnt/wslg`, a hand-made
 * `/mnt/data`) don't match. Case-insensitive because `\w` echoes whatever
 * the shell was given, and a hand-typed `cd /mnt/C/...` reaches bash
 * unchanged. Only the default root is recognized - a distro that moved it
 * via wsl.conf's `automount.root` falls through to the UNC form, no worse
 * off than before this existed. */
const DRIVE_MOUNT = /^\/mnt\/([a-z])(?=\/|$)/i;

/** `/home/user` + "Ubuntu" -> `\\wsl.localhost\Ubuntu\home\user` - the path
 * Windows Explorer (and this app's own file-listing commands) can actually
 * read, since a bare POSIX path means nothing to a Windows fs call.
 *
 * With one exception that is *not* an edge case: a `/mnt/<drive>` path goes
 * back to its plain `C:\...` form instead. The 9P share behind
 * `\\wsl.localhost` refuses to traverse the distro's DrvFs mounts - it hands
 * out ERROR_ACCESS_DENIED (os error 5) for anything under
 * `\\wsl.localhost\<distro>\mnt\c`, even though `...\mnt` itself lists fine -
 * so routing a Windows drive back out through the share would be both a
 * pointless round trip and a guaranteed failure. It's the common case, too:
 * `wsl` inherits the host shell's cwd, so a tab sitting in a project
 * directory lands in `/mnt/c/...` rather than the home tree. */
export function toWindowsPath(distro: string, posixPath: string): string {
  const drive = posixPath.match(DRIVE_MOUNT);
  if (drive) {
    const rest = posixPath.slice(drive[0].length).replace(/^\//, "").replace(/\//g, "\\");
    return `${drive[1].toUpperCase()}:\\${rest}`;
  }
  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

/** The reverse of `toWindowsPath` - needed when the explorer, browsing a
 * translated path, sends the user into a subfolder: that click has to `cd`
 * the *actual* WSL bash session, which only understands its own POSIX path,
 * not the Windows form this app made up for the file listing's sake. Handles
 * both shapes that function can produce, drive paths included. `null` if
 * `path` is neither - i.e. nothing this distro could `cd` to. */
export function toWslPath(distro: string, path: string): string | null {
  const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (drive) {
    const rest = drive[2] ? `/${drive[2].replace(/\\/g, "/").replace(/\/$/, "")}` : "";
    return `/mnt/${drive[1].toLowerCase()}${rest}`;
  }
  const prefix = `\\\\wsl.localhost\\${distro}`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = path.slice(prefix.length).replace(/\\/g, "/");
  return rest || "/";
}

/** The distro a `\\wsl.localhost\<distro>\...` (or older `\\wsl$\...`)
 * path lives in - i.e. a folder only a WSL shell of that distro can `cd`
 * into. `null` for anything else, `C:\...` drive paths included (those are
 * reachable from every shell). */
export function wslDistroOfPath(path: string): string | null {
  return path.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i)?.[1] ?? null;
}

/** `pty_spawn` shell id for a WSL session - `wsl:<distro>` pins the distro
 * (see `resolve_shell`/`pty_spawn` in pty.rs), plain `wsl` means the
 * machine's default one. */
export function wslShellId(distro?: string | null): string {
  return distro ? `wsl:${distro}` : "wsl";
}

/** `undefined` if `shellId` isn't a WSL one at all, `null` for plain `wsl`
 * (default distro), the distro name for `wsl:<distro>`. */
export function wslDistroOfShell(shellId: string | undefined): string | null | undefined {
  if (!shellId) return undefined;
  if (shellId === "wsl") return null;
  return shellId.startsWith("wsl:") ? shellId.slice(4) || null : undefined;
}

/** Whether two shell ids start the same kind of terminal - `system` and an
 * empty id are the same thing, and plain `wsl` matches any `wsl:<distro>`
 * (it may well *be* that distro, and there's no cheap way to tell here). */
export function sameShell(a: string | undefined, b: string | undefined): boolean {
  const norm = (id: string | undefined) => (!id || id === "system" ? "system" : id);
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return true;
  const [dx, dy] = [wslDistroOfShell(x), wslDistroOfShell(y)];
  return dx !== undefined && dy !== undefined && (dx === null || dy === null || dx === dy);
}
