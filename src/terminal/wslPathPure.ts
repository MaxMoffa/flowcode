// Pure WSL path helpers (no tauri imports), shared with the phone bundle.

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
  // Boundary check too: "Ubuntu" must not match "Ubuntu-22.04".
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  if (path.length > prefix.length && path[prefix.length] !== "\\" && path[prefix.length] !== "/") return null;
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
