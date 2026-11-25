// What the in-app browser's own pages say: which page a load error maps to, the lines of its details dialog and
// the message handed to an agent. Pure, so it is tested without the UI.
import type { MessageKey } from "../i18n";
import type { ArtId } from "./errorArt";
import type { PageError } from "./browserStore";
import { isLocalUrl } from "./browserStore";

export type StatusPageId = ArtId;

/** The page an error is shown with. A refused connection to a loopback address is "the dev server is down". */
export function statusPageFor(error: PageError): StatusPageId {
  switch (error.kind) {
    case "refused":
      return isLocalUrl(error.url) ? "local" : "offline";
    case "dns":
    case "offline":
    case "other":
      return "offline";
    case "timeout":
    case "cert":
    case "blocked":
    case "crash":
      return error.kind;
  }
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The port of an address, explicit or the scheme's default; "" when it is not one. */
export function portOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  } catch {
    return "";
  }
}

export interface StatusLine {
  label: MessageKey;
  value: string;
}

/** The detail lines under the code bar: when it happened, and for a dead local server the ports that do answer. */
export function detailLines(page: StatusPageId, error: PageError | null, liveServers: { port: number }[], locale?: string): StatusLine[] {
  const lines: StatusLine[] = [];
  if (error) lines.push({ label: "browser.page.detail.time", value: new Date(error.at).toLocaleTimeString(locale) });
  if (page === "local" || page === "newtab") {
    lines.push({ label: "browser.page.detail.ports", value: liveServers.length ? liveServers.map((s) => `:${s.port}`).join(" ") : "-" });
  }
  return lines;
}

/** A plain-words reading of an error code (WebView2 status, WebKit message, ours), with the HTTP status when the
 * code carries one (`UNKNOWN (HTTP 404)`). null = nothing better to say than the code itself. */
export function codeMeaning(code: string): { key: MessageKey; http?: string } | null {
  const http = /\(HTTP (\d{3})\)/.exec(code)?.[1];
  const name = code.split(" ")[0];
  if (http && Number(http) >= 400) return { key: "browser.page.meaning.http", http };
  switch (name) {
    case "UNKNOWN":
      return { key: http ? "browser.page.meaning.unknownLoaded" : "browser.page.meaning.unknown" };
    case "CANNOT_CONNECT":
    case "CONNECTION_REFUSED":
      return { key: "browser.page.meaning.refused" };
    case "CONNECTION_ABORTED":
    case "CONNECTION_RESET":
      return { key: "browser.page.meaning.dropped" };
    case "OPERATION_CANCELED":
      return { key: "browser.page.meaning.canceled" };
    case "SERVER_UNREACHABLE":
    case "DISCONNECTED":
      return { key: "browser.page.meaning.offline" };
    case "HOST_NAME_NOT_RESOLVED":
      return { key: "browser.page.meaning.dns" };
    case "TIMEOUT":
      return { key: "browser.page.meaning.timeout" };
    case "REDIRECT_FAILED":
      return { key: "browser.page.meaning.redirect" };
    case "ERROR_HTTP_INVALID_SERVER_RESPONSE":
      return { key: "browser.page.meaning.badResponse" };
    case "UNEXPECTED_ERROR":
      return { key: "browser.page.meaning.engine" };
    case "BLOCKED_LOCAL_ORIGIN":
      return { key: "browser.page.meaning.blocked" };
    case "RENDER_PROCESS_EXITED":
    case "RENDER_PROCESS_UNRESPONSIVE":
      return { key: "browser.page.meaning.crash" };
  }
  return name.startsWith("CERTIFICATE_") || name.startsWith("CLIENT_CERTIFICATE_") ? { key: "browser.page.meaning.cert" } : null;
}

/** Plain text of the whole dialog, for Copy. */
export function detailsText(code: string, url: string, kindLabel: string, lines: { label: string; value: string }[]): string {
  return [`${code}${url ? ` · ${url}` : ""}`, ...(kindLabel ? [kindLabel] : []), ...lines.map((l) => `${l.label}: ${l.value}`)].join("\n");
}
