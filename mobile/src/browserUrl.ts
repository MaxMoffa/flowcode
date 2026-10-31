// Addresses of the in-app browser: what the user types becomes a "page", and a
// page becomes the URL of the iframe, served by the `flowcode-remote` scheme
// (`/p/<port>/...` is a loopback port of the desktop, `/f/<ptyId>/...` a file
// of that terminal's working folder).
import { convertFileSrc } from "@tauri-apps/api/core";
import { pluginFileUrl } from "../../shared/agentViewBridge";

export type Page = { kind: "port"; port: number; path: string } | { kind: "file"; ptyId: string; path: string };

const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `host:port` with an optional `/path?query#hash` after it, or a bare port. */
const HOST_PORT = /^(?:(\[[^\]]*\]|[^/:?#\s]+):)?(\d+)((?:[/?#].*)?)$/;

function portPage(port: string, rest: string): Page | null {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // The path keeps its leading slash; a bare `?x=1` becomes `/?x=1`.
  return { kind: "port", port: n, path: rest === "" || rest[0] !== "/" ? "/" + rest : rest };
}

/** What the user typed in the address field; null when it is neither a loopback address nor (with a terminal) a relative file. */
export function parseTyped(input: string, ptyId: string | null): Page | null {
  let s = input.trim().replace(/^:(?=\d)/, "");
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1])) return null;
    s = s.slice(scheme[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) {
    return null; // mailto:, javascript:, data:, C:\...
  }
  const m = HOST_PORT.exec(s);
  if (m) {
    const host = m[1]?.toLowerCase();
    if (host !== undefined && !HOSTS.has(host)) return null;
    // A bare number is a port only if it is not a file such as "404".
    return portPage(m[2], m[3]);
  }
  if (scheme) {
    // http://localhost/x (no port) is not served: the tunnel needs a port.
    return null;
  }
  if (!ptyId) return null;
  const path = s.replace(/^\.?\//, "");
  if (!path || path.startsWith("/") || path.split(/[/\\]/).includes("..")) return null;
  return { kind: "file", ptyId, path: path.replace(/\\/g, "/") };
}

/** The iframe URL of a page. `base` builds the scheme URL of a path (injectable for tests). */
export function pageSrc(page: Page, base: (path: string) => string = (p) => convertFileSrc(p, "flowcode-remote")): string {
  if (page.kind === "port") {
    const [pathPart, ...q] = page.path.split("?");
    const query = q.length ? "?" + q.join("?") : "";
    return pluginFileUrl(base("p"), `${page.port}/${pathPart.replace(/^\/+/, "")}`) + query;
  }
  const [pathPart, ...q] = page.path.split("?");
  const query = q.length ? "?" + q.join("?") : "";
  return pluginFileUrl(base("f"), `${page.ptyId}/${pathPart.replace(/^\/+/, "")}`) + query;
}

/** A short label for the address field. */
export function pageLabel(page: Page): string {
  return page.kind === "port" ? `localhost:${page.port}${page.path === "/" ? "" : page.path}` : page.path;
}

/** A served file is an artifact and must not share the origin of the app; a dev server needs its own. */
export function sandboxFor(page: Page): string {
  return page.kind === "port" ? "allow-scripts allow-same-origin allow-forms allow-modals" : "allow-scripts";
}
