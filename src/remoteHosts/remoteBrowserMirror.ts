// The Browser panel of this window mirrors the browser tabs of the PC in front
// (what the phone does with this PC's tabs: `browsertabs` snapshots in,
// `browserop` requests out). Each remote tab becomes a page of the panel
// tagged with where it came from; its content loads through the tunnel, so a
// dev server of the other PC or a file next to a page opens here. Which page
// is in front stays this window's own choice.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserTabPage, BrowserTabsSnapshot, ServerMsg } from "../../shared/remote-types";
import { dropMirroredPages, setMirrorHooks, upsertMirroredPage, type MirrorTarget } from "../browser/browserStore";
import { onHostMessages, sendToHost, useHost, useHostLink } from "./remoteHosts";
import { toHostUrl } from "../browser/mirrorUrl";
import { browserPageFileUrl, tunnelUrl } from "./remoteTunnel";

/** The other PC may use either separator. */
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const isHttp = (s: string) => /^https?:\/\//i.test(s);

/** What a tab of the other PC's browser shows, as `{kind, key}`: `key` changes exactly when the other PC changed the page. */
export function mirrorKey(page: BrowserTabPage): string {
  return page.kind === "url" ? `url|${page.url}` : page.kind === "file" ? `file|${page.path}` : `pdf|${page.src}`;
}

/** The page of this panel that shows a tab of `hostId`'s browser: addresses on its loopback and files next to its pages go through a tunnel. */
export async function mirrorTarget(hostId: string, page: BrowserTabPage): Promise<MirrorTarget> {
  if (page.kind === "url") return { kind: "url", url: await tunnelUrl(hostId, page.url) };
  if (page.kind === "pdf" && isHttp(page.src)) return { kind: "pdf", src: await tunnelUrl(hostId, page.src) };
  const path = page.kind === "file" ? page.path : page.src;
  const url = await browserPageFileUrl(hostId, page.id, nameOf(path));
  // A PDF on the other PC's disk opens in our viewer from that address; any other file is a page.
  return page.kind === "pdf" ? { kind: "pdf", src: url } : { kind: "url", url };
}

/** The PC whose browser is mirrored now (the one in front), and the nonce of the tab we asked it to open: that tab comes forward when it shows up. */
let current: { hostId: string; pending: string | null } | null = null;

setMirrorHooks({
  open: (url) => {
    if (!current || !/^https?:\/\//i.test(url)) return false;
    const nonce = crypto.randomUUID();
    current.pending = nonce;
    void sendToHost(current.hostId, { t: "browserop", op: { op: "openUrl", url, nonce } });
    return true;
  },
  close: (tag) => void sendToHost(tag.hostId, { t: "browserop", op: { op: "close", id: tag.remoteId } }),
  // An address on this end of the page's tunnel means the same port on the other PC.
  navigate: (tag, url) => void sendToHost(tag.hostId, { t: "browserop", op: { op: "navigate", id: tag.remoteId, url: toHostUrl(url, tag) } }),
});

/** The host keeps a tunnel only while it is used: touching it this often keeps the mirrored pages' addresses alive. */
const KEEPALIVE_MS = 4 * 60_000;

/** Mirrors `hostId`'s browser tabs into the panel until stopped; the pages go with it. `refresh` asks the tunnels again (after a new link). */
function startBrowserMirror(hostId: string): { stop: () => void; refresh: () => void } {
  let stopped = false;
  let generation = 0;
  let first = true;
  let last: BrowserTabsSnapshot | null = null;

  const apply = async (snapshot: BrowserTabsSnapshot) => {
    last = snapshot;
    const mine = ++generation;
    const resolved = await Promise.all(
      snapshot.pages.map(async (page) => {
        try {
          return { page, target: await mirrorTarget(hostId, page) };
        } catch {
          return { page, target: null }; // no tunnel now: the page shows up with the next snapshot
        }
      }),
    );
    // A newer snapshot arrived while the tunnels were being made, or the PC left the front.
    if (stopped || mine !== generation) return;
    const live = new Set(snapshot.pages.map((p) => p.id));
    dropMirroredPages(hostId, live);
    const wasFirst = first;
    first = false;
    // The tab we asked for: it comes forward once, like a tab opened here.
    const asked = current?.hostId === hostId && current.pending && snapshot.opened?.nonce === current.pending ? snapshot.opened.pageId : null;
    if (asked && current) current.pending = null;
    for (const { page, target } of resolved) {
      if (!target) continue;
      const activate = (wasFirst && page.id === snapshot.activeId) || page.id === asked;
      upsertMirroredPage({ hostId, remoteId: page.id, key: mirrorKey(page), ...(page.kind === "url" ? { origin: page.url } : {}) }, target, activate);
    }
  };

  const fromMessages = (msgs: ServerMsg[]) => {
    for (const m of msgs) if (m.t === "browsertabs") void apply(m.tabs);
  };
  current = { hostId, pending: null };
  const off = onHostMessages(hostId, fromMessages);
  // The snapshot the backend already holds: the host only sends it when it changes.
  invoke<ServerMsg[]>("remote_host_cached", { id: hostId })
    .then((msgs) => !stopped && fromMessages(msgs))
    .catch(() => {});

  const refresh = () => {
    if (last && last.pages.length > 0) void apply(last);
  };
  const keepalive = setInterval(refresh, KEEPALIVE_MS);

  return {
    stop: () => {
      stopped = true;
      if (current?.hostId === hostId) current = null;
      clearInterval(keepalive);
      off();
      dropMirroredPages(hostId);
    },
    refresh,
  };
}

/** Mounted while a PC is in front: its browser tabs appear in the Browser panel when it has them to share and is online. */
export function useRemoteBrowserMirror(hostId: string) {
  const host = useHost(hostId);
  const active = host?.status === "online" && host.caps.includes("browserTabs");
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    const mirror = startBrowserMirror(hostId);
    refreshRef.current = mirror.refresh;
    return () => {
      refreshRef.current = null;
      mirror.stop();
    };
  }, [hostId, active]);
  // A new link: the tunnels of the old one may be gone; resolve the targets again (pages with a new address reload).
  const link = useHostLink(hostId);
  useEffect(() => refreshRef.current?.(), [link]);
}
