// The previews of the links in a chat: asked of the desktop (which fetches the page), kept for the session.
import type { LinkPreview } from "../../shared/remote-types";
import { onMessage, send } from "./remote";
import { createStore } from "./store";

/** How long a request may go unanswered (a link that dropped meanwhile) before it counts as "no preview". */
const REPLY_TIMEOUT_MS = 20_000;

/** A preview, null when there is none, "pending" while asked. */
type Entry = LinkPreview | null | "pending";

const store = createStore<{ entries: Record<string, Entry> }>({ entries: {} });

/** Previews kept; the oldest written go first (they carry data: images). */
const MAX_ENTRIES = 200;
/** The desktop the previews came from. */
let lastHost: string | undefined;

function setEntry(url: string, entry: Entry) {
  const next = { ...store.get().entries };
  delete next[url];
  next[url] = entry;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete next[keys[i]];
  store.set({ entries: next });
}
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const picture = (v: unknown) => (typeof v === "string" && v.startsWith("data:image/") ? v : undefined);

/** A preview as the desktop sent it, keeping only fields of the right shape; null when there is nothing to show. */
/** @internal exported for tests */
export function cleanPreview(raw: unknown): LinkPreview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = text(r.url);
  if (!url) return null;
  const preview: LinkPreview = {
    url,
    finalUrl: text(r.finalUrl) ?? url,
    title: text(r.title),
    description: text(r.description),
    siteName: text(r.siteName),
    image: picture(r.image),
    favicon: picture(r.favicon),
  };
  return preview.title || preview.description || preview.image ? preview : null;
}

/** Asks the desktop for a link's preview, once per link for the session. */
export function requestLinkPreview(url: string) {
  if (url in store.get().entries) return;
  setEntry(url, "pending");
  send({ t: "linkpreview", url });
  setTimeout(() => {
    if (store.get().entries[url] === "pending") setEntry(url, null);
  }, REPLY_TIMEOUT_MS);
}

/** The state of a link's preview; undefined until asked. */
export const useLinkPreview = (url: string): Entry | undefined => store.useSelector((s) => s.entries[url]);

onMessage((m) => {
  if (m.t === "ready" && m.hostName !== lastHost) {
    lastHost = m.hostName;
    store.set({ entries: {} });
  }
  // The reply names the url that was asked, which the preview's own `url` repeats.
  if (m.t === "linkpreview") setEntry(m.url, cleanPreview(m.preview));
});
