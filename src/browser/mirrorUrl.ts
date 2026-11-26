// Address mapping for the pages that mirror another PC's browser tabs: the page loads through a local tunnel
// (`localhost:<tunnel>`), but the address that means something is the other PC's (`localhost:<port>`).
import type { MirrorTag } from "./browserStore";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** `url` as the other PC knows it: an address on this end of the page's tunnel (localhost / 127.0.0.1 at the tunnel port) goes back to the page's original host and port. Anything else comes back unchanged. */
export function toHostUrl(url: string, tag: Pick<MirrorTag, "local" | "origin">): string {
  const local = parse(tag.local);
  const origin = parse(tag.origin);
  const u = parse(url);
  if (!local || !origin || !u || !LOOPBACK.test(u.hostname) || u.port !== local.port) return url;
  u.protocol = origin.protocol;
  u.hostname = origin.hostname;
  u.port = origin.port;
  return u.toString();
}
