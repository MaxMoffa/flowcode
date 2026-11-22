// Addresses of the in-app browser: what the user types becomes a "page", and a
// page becomes the URL of the iframe, served by the `flowcode-remote` scheme
// (`/p/<port>/...` is a loopback port of the desktop, `/f/<ptyId>/...` a file
// of that terminal's working folder, `/c/<chatId>/...` a file of a chat).
import { convertFileSrc } from "@tauri-apps/api/core";
import { pluginFileUrl } from "../../shared/agentViewBridge";
import type { BrowserOp, BrowserTabPage } from "../../shared/remote-types";

export type Page =
  | { kind: "port"; port: number; path: string }
  | { kind: "file"; ptyId: string; path: string }
  | { kind: "chatFile"; chatId: string; path: string }
  /** A file of a desktop browser tab (`/b/<pageId>/<name>`), served from the file's folder. */
  | { kind: "deskFile"; pageId: string; name: string };

const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `host:port` with an optional `/path?query#hash` after it, or a bare port. */
const HOST_PORT = /^(?:(\[[^\]]*\]|[^/:?#\s]+):)?(\d+)((?:[/?#].*)?)$/;

function portPage(port: string, rest: string): Page | null {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // The path keeps its leading slash; a bare `?x=1` becomes `/?x=1`.
  return { kind: "port", port: n, path: rest === "" || rest[0] !== "/" ? "/" + rest : rest };
}

/** A loopback address, or a relative file when a chat or terminal provides its root. */
export function parseTyped(input: string, ptyId: string | null, chatId: string | null = null): Page | null {
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
  if (!ptyId && !chatId) return null;
  const path = s.replace(/^\.?\//, "");
  if (!path || path.startsWith("/") || path.split(/[/\\]/).includes("..")) return null;
  return chatId
    ? { kind: "chatFile", chatId, path: path.replace(/\\/g, "/") }
    : { kind: "file", ptyId: ptyId!, path: path.replace(/\\/g, "/") };
}

/** The page of a tapped web link, when it is a loopback address of the desktop. */
export function localLinkPage(url: string): Page | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") parsed.hostname = "localhost";
    return parseTyped(parsed.toString(), null);
  } catch { return null; }
}

/** Encodes one path segment of an address the user typed or a link carried: valid `%XX` escapes stay as they are (no double encoding), everything else unsafe is encoded (`100%` becomes `100%25`). */
function encodeTypedSegment(seg: string): string {
  return seg
    .split(/(%[0-9a-fA-F]{2})/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      try {
        return encodeURIComponent(part);
      } catch {
        // A lone surrogate cannot be encoded.
        return encodeURIComponent(part.replace(/[\uD800-\uDFFF]/g, "�"));
      }
    })
    .join("");
}

/** The iframe URL of a page. `base` builds the scheme URL of a path (injectable for tests). */
export function pageSrc(page: Page, base: (path: string) => string = (p) => convertFileSrc(p, "flowcode-remote")): string {
  if (page.kind === "port") {
    // A web address: `path?query#hash`, where the path may already be percent-encoded and a hash
    // (e.g. `/#/settings` of a hash router) is a fragment, never part of the path.
    const hashAt = page.path.indexOf("#");
    const hash = hashAt >= 0 ? page.path.slice(hashAt) : "";
    const beforeHash = hashAt >= 0 ? page.path.slice(0, hashAt) : page.path;
    const queryAt = beforeHash.indexOf("?");
    const query = queryAt >= 0 ? beforeHash.slice(queryAt) : "";
    const pathname = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
    const segments = pathname.replace(/^\/+/, "").split("/").map(encodeTypedSegment).join("/");
    return `${base("p").replace(/\/+$/, "")}/${page.port}/${segments}${query}${hash}`;
  }
  // A file of the desktop: the path is a literal file name (`%` and `#` are part of it and get
  // encoded). Only a `?` starts a query, and everything after it, hash included, is kept as is.
  if (page.kind === "deskFile") return pluginFileUrl(base("b"), `${page.pageId}/${page.name}`);
  const [pathPart, ...q] = page.path.split("?");
  const query = q.length ? "?" + q.join("?") : "";
  const prefix = page.kind === "chatFile" ? "c" : "f";
  const id = page.kind === "chatFile" ? page.chatId : page.ptyId;
  return pluginFileUrl(base(prefix), `${id}/${pathPart.replace(/^\/+/, "")}`) + query;
}

/** A short label for the address field. */
export function pageLabel(page: Page): string {
  if (page.kind === "deskFile") return page.name;
  return page.kind === "port" ? `localhost:${page.port}${page.path === "/" ? "" : page.path}` : page.path;
}

/** A served file is an artifact and must not share the origin of the app; a dev server needs its own. */
export function sandboxFor(page: Page): string {
  return page.kind === "port" ? "allow-scripts allow-same-origin allow-forms allow-modals" : "allow-scripts";
}

/** A desktop tab as the phone shows it: an iframe page, or a placeholder for an external address or a PDF. */
export function deskPageToPage(p: BrowserTabPage): Page | { kind: "external"; url: string } | { kind: "pdf"; src: string } {
  if (p.kind === "pdf") return { kind: "pdf", src: p.src };
  if (p.kind === "file") return { kind: "deskFile", pageId: p.id, name: p.path.split(/[/\\]/).filter(Boolean).pop() ?? p.path };
  return localLinkPage(p.url) ?? { kind: "external", url: p.url };
}

/** The request that makes the desktop open a page the phone visits; null for a desktop tab (it already exists). */
export function pageToOp(page: Page, nonce: string): BrowserOp | null {
  switch (page.kind) {
    case "port":
      return { op: "openUrl", url: `http://localhost:${page.port}${page.path}`, nonce };
    case "chatFile":
      return { op: "openFile", root: { chatId: page.chatId }, path: page.path, nonce };
    case "file":
      return { op: "openFile", root: { ptyId: page.ptyId }, path: page.path, nonce };
    default:
      return null;
  }
}
