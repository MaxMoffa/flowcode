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

/** Plain text of the whole dialog, for Copy. */
export function detailsText(code: string, url: string, kindLabel: string, lines: { label: string; value: string }[]): string {
  return [`${code}${url ? ` · ${url}` : ""}`, ...(kindLabel ? [kindLabel] : []), ...lines.map((l) => `${l.label}: ${l.value}`)].join("\n");
}
