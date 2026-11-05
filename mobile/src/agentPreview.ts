import { isPreviewableFile } from "../../shared/agentOpen";
import { splitLinks } from "../../src/chat/chatLinks";
import { localLinkPage, pageLabel, parseTyped, type Page } from "./browserUrl";

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
  if (/^https?:\/\//i.test(open.target)) return localLinkPage(open.target);
  if (!filesSupported) return null;
  const path = relativeArtifactPath(open.target, open.cwd, rootCwd);
  return path ? parseTyped(path, null, chatId) : null;
}

/** A file linked in the chat, when it can be shown and lives in the chat's folder. */
export function fileLinkPage(path: string, chatId: string, rootCwd: string): Page | null {
  if (!isPreviewableFile(path)) return null;
  const relative = relativeArtifactPath(path, rootCwd, rootCwd);
  return relative ? parseTyped(relative, null, chatId) : null;
}

/** The pages linked in a chat's agent messages, newest first and without repeats. */
export function chatLinkPages(texts: string[], chatId: string | null, rootCwd: string, limit = 6): Page[] {
  const pages: Page[] = [];
  const seen = new Set<string>();
  for (let i = texts.length - 1; i >= 0 && pages.length < limit; i--) {
    for (const line of texts[i].split("\n")) {
      for (const part of splitLinks(line)) {
        const page = part.url ? localLinkPage(part.url) : part.path !== undefined && chatId ? fileLinkPage(part.path, chatId, rootCwd) : null;
        if (!page) continue;
        const label = pageLabel(page);
        if (seen.has(label)) continue;
        seen.add(label);
        pages.push(page);
        if (pages.length >= limit) return pages;
      }
    }
  }
  return pages;
}
