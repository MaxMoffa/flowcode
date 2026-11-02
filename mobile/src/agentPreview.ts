import { parseTyped, type Page } from "./browserUrl";

function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/").replace(/\/$/, "");
}

/** A file stays inside the chat's folder, including paths from a WSL agent. */
export function relativeArtifactPath(target: string, commandCwd: string, rootCwd: string): string | null {
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(rootCwd);
  const wslRoot = rootCwd.replace(/\\/g, "/").match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)$/i);
  const localPath = (value: string) => {
    const path = value.replace(/\\/g, "/");
    const unc = path.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)$/i);
    if (wslRoot && unc && unc[1].toLowerCase() === wslRoot[1].toLowerCase()) return unc[2];
    if (windows && !wslRoot) return path.replace(/^\/mnt\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive}:`);
    return path;
  };
  const base = wslRoot ? wslRoot[2] : rootCwd;
  const cwd = localPath(commandCwd);
  const pathTarget = localPath(target);
  const absolute = /^[a-z]:[\\/]|^[\\/]/i.test(pathTarget) ? pathTarget : `${cwd}/${pathTarget}`;
  const root = normalized(base);
  const path = normalized(absolute);
  const compare = (value: string) => windows && !wslRoot ? value.toLowerCase() : value;
  if (!compare(path).startsWith(compare(root) + "/")) return null;
  return path.slice(root.length + 1);
}

/** An automatic opener shows loopback servers or files scoped to this chat. */
export function agentPreviewPage(open: { target: string; cwd: string }, chatId: string, rootCwd: string, filesSupported: boolean): Page | null {
  if (/^https?:\/\//i.test(open.target)) {
    try {
      const url = new URL(open.target);
      if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
      return parseTyped(url.toString(), null);
    } catch { return null; }
  }
  if (!filesSupported) return null;
  const path = relativeArtifactPath(open.target, open.cwd, rootCwd);
  return path ? parseTyped(path, null, chatId) : null;
}
