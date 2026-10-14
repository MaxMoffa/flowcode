import { toWslPath, wslDistroOfPath, wslDistroOfShell } from "../terminal/wslPath";
import { isWindowsPlatform } from "../lib/path";

/** The prompt the chosen shell would print - only its shape (PowerShell's
 * `PS C:\...>`, cmd's `C:\...>`, a POSIX `$`), so the page's prompt reads as
 * that shell's first line. */
export function promptFor(shell: string, defaultLabel: string, dir: string): string {
  if (wslDistroOfShell(shell) !== undefined) {
    const posix = dir ? toWslPath(wslDistroOfPath(dir) ?? "", dir) : null;
    return `${posix ?? "~"} $ `;
  }
  const where = dir || "~";
  if (shell === "cmd") return `${where}>`;
  if (isPowerShell(shell, defaultLabel) || (shell === "system" && isWindowsPlatform())) return `PS ${where}> `;
  return `${where} $ `;
}

/** Whether `shell` starts PowerShell - the default one too, which on Windows
 * is PowerShell unless its label says otherwise. */
export function isPowerShell(shell: string, defaultLabel: string): boolean {
  if (shell === "powershell" || shell === "pwsh") return true;
  return shell === "system" && (/powershell/i.test(defaultLabel) || (isWindowsPlatform() && !defaultLabel));
}

/** A favorite's folder as the list shows it: a WSL folder by its POSIX
 * path, the way its shell prints it. Wrapped in LRM marks so the column's
 * `direction: rtl` (which trims long paths from the left) doesn't move the
 * leading `\\` or a trailing slash to the other end. */
export function shownPath(path: string): string {
  const distro = wslDistroOfPath(path);
  const posix = distro ? toWslPath(distro, path) : null;
  return `\u200e${posix ?? path}\u200e`;
}
