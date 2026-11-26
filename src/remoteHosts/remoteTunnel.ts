import { invoke } from "@tauri-apps/api/core";

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]|.+\.localhost)$/i;

/** The port a web address on the other PC's own loopback names, or null for any other address (an external site, a file). */
export function loopbackPort(url: string): number | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.test(u.hostname)) return null;
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** `url` with its host and port swapped for this PC's end of a tunnel to that port on `hostId` (a local dev server of the other PC then opens here). Other addresses come back unchanged. */
export async function tunnelUrl(hostId: string, url: string): Promise<string> {
  const port = loopbackPort(url);
  if (port === null) return url;
  const local = await invoke<number>("remote_host_tunnel", { id: hostId, port });
  const u = new URL(url);
  u.hostname = "localhost";
  u.port = String(local);
  return u.toString();
}

/** A page of the other PC's chat folder (`relative` to it, forward slashes) as an address that opens here: its files are served over a tunnel by that PC. */
export async function chatFileUrl(hostId: string, chatId: string, relative: string): Promise<string> {
  const local = await invoke<number>("remote_host_tunnel", { id: hostId, chatId });
  return `http://localhost:${local}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/** A file of a page of the other PC's browser (`pageId`, the file's `name` in the folder that page is in) as an address that opens here. */
export async function browserPageFileUrl(hostId: string, pageId: string, name: string): Promise<string> {
  const local = await invoke<number>("remote_host_tunnel", { id: hostId, pageId });
  return `http://localhost:${local}/${encodeURIComponent(name)}`;
}
