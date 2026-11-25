// Bridge to the native child webviews of the in-app browser (src-tauri/src/
// browser_view.rs). Only `kind: "url"` pages use them; the commands act on the
// window that calls them, and the events are emitted to that window only.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, type RefObject } from "react";

export interface NativeViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Show / bounds / hide run one after the other: Tauri runs async commands in
// parallel, so a hide sent before a show could otherwise land after it and
// leave the view hidden (or an old rect could land after a newer one).
let placeChain: Promise<unknown> = Promise.resolve();
function placed<T>(run: () => Promise<T>): Promise<T> {
  const next = placeChain.then(run, run);
  placeChain = next.catch(() => {});
  return next;
}

export const nativeView = {
  show: (pageId: string, url: string, r: NativeViewRect) => placed(() => invoke<void>("browser_view_show", { pageId, url, ...r })),
  bounds: (pageId: string, r: NativeViewRect) => placed(() => invoke<void>("browser_view_bounds", { pageId, ...r })),
  /** One page, or every child of this window when `pageId` is omitted. */
  hide: (pageId?: string) => placed(() => invoke<void>("browser_view_hide", { pageId: pageId ?? null })),
  navigate: (pageId: string, url: string) => invoke<void>("browser_view_navigate", { pageId, url }),
  back: (pageId: string) => invoke<void>("browser_view_back", { pageId }),
  forward: (pageId: string) => invoke<void>("browser_view_forward", { pageId }),
  reload: (pageId: string, ignoreCache = false) => invoke<void>("browser_view_reload", { pageId, ignoreCache }),
  close: (pageId: string) => invoke<void>("browser_view_close", { pageId }),
  devtools: (pageId: string) => invoke<void>("browser_view_devtools", { pageId }),
  /** Clears cookies/storage of the shared browser profile (needs a live view for `pageId`). */
  clearData: (pageId: string) => invoke<void>("browser_view_clear_data", { pageId }),
  /** Colour (`#rrggbb`) the views paint while a page loads, instead of white. */
  theme: (color: string) => placed(() => invoke<void>("browser_view_theme", { color })),
  /** PNG data URL of what the view shows now (Windows only; null elsewhere or when the capture failed). */
  snapshot: (pageId: string) => invoke<string | null>("browser_view_snapshot", { pageId }),
  /** `<origin>/favicon.ico` of a public site as a data URL, or null. */
  favicon: (url: string) => invoke<string | null>("browser_favicon", { url }),
  /** Whether something listens at a loopback address (TCP connect, 700 ms). Rejects for any other host. */
  probeLocal: (url: string) => invoke<boolean>("browser_probe_local", { url }),
};

/** The in-app browser's downloads (src-tauri/src/browser_downloads.rs). */
export const downloads = {
  list: () => invoke<DownloadItem[]>("browser_downloads_list"),
  /** `accept` moves the file to the Downloads folder, otherwise it is deleted. */
  answer: (id: string, accept: boolean) => invoke<void>("browser_download_answer", { id, accept }),
  cancel: (id: string) => invoke<void>("browser_download_cancel", { id }),
  open: (id: string) => invoke<void>("browser_download_open", { id }),
  reveal: (id: string) => invoke<void>("browser_download_reveal", { id }),
  openFolder: () => invoke<void>("browser_downloads_open_folder"),
  /** Drops the entry from the list; the downloaded file stays. */
  remove: (id: string) => invoke<void>("browser_download_remove", { id }),
  clear: () => invoke<void>("browser_downloads_clear"),
  retry: (id: string) => invoke<void>("browser_download_retry", { id }),
};

export interface NativeNavigated {
  pageId: string;
  url: string;
}
export interface NativeLoad {
  pageId: string;
  state: "started" | "finished";
  url: string;
}
export interface NativeTitle {
  pageId: string;
  title: string;
}
export interface NativeNewWindow {
  pageId: string;
  url: string;
}
export type NativeErrorKind = "refused" | "dns" | "offline" | "timeout" | "cert" | "blocked" | "crash" | "other";
export interface NativeError {
  pageId: string;
  kind: NativeErrorKind;
  /** The engine's raw code (CONNECTION_REFUSED, RENDER_PROCESS_EXITED...), for the details dialog. */
  code: string;
  url: string;
}
export type DownloadState = "asking" | "downloading" | "done" | "failed";
/** What `browser-download` carries: an item of the downloads list. `cancelled` / `removed` mean it left the list. */
export interface DownloadItem {
  id: string;
  pageId: string;
  window: string;
  url: string;
  host: string;
  fileName: string;
  state: DownloadState | "cancelled" | "removed";
  dangerous: boolean;
  size: number | null;
  /** Epoch milliseconds. */
  startedAt: number;
  /** While `asking`: the file is already completely downloaded. */
  finished: boolean;
  /** Final path once `done`. */
  path: string | null;
}

// Window-scoped listen: `getCurrentWebviewWindow().listen` only receives events
// emitted to this window's label, so another window's browser never leaks in.
function sub<T>(event: string, cb: (p: T) => void): () => void {
  const un = getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload));
  return () => void un.then((f) => f());
}

export const onNativeNavigated = (cb: (p: NativeNavigated) => void) => sub("browser-view-navigated", cb);
export const onNativeLoad = (cb: (p: NativeLoad) => void) => sub("browser-view-load", cb);
export const onNativeTitle = (cb: (p: NativeTitle) => void) => sub("browser-view-title", cb);
export const onNativeNewWindow = (cb: (p: NativeNewWindow) => void) => sub("browser-view-new-window", cb);
export const onNativeError = (cb: (p: NativeError) => void) => sub("browser-view-error", cb);
export const onDownload = (cb: (p: DownloadItem) => void) => sub("browser-download", cb);

function readRect(el: HTMLElement, insetBottom: number, ring = 0): NativeViewRect | null {
  const b = el.getBoundingClientRect();
  const height = b.height - insetBottom - 2 * ring;
  const width = b.width - 2 * ring;
  if (width < 1 || height < 1) return null;
  return { x: b.left + ring, y: b.top + ring, width, height };
}

/** Same size, far outside the window: the view keeps its painted page while out of sight. */
const parkedRect = (r: NativeViewRect): NativeViewRect => ({ ...r, x: -20000 - r.width, y: -20000 - r.height });

const same = (a: NativeViewRect | null, b: NativeViewRect) =>
  !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Frames a stable rect is still watched after the last change (covers CSS transitions). */
const SETTLE_FRAMES = 20;
/** At most one bounds call per this many ms while the rect moves. */
const BOUNDS_INTERVAL_MS = 16;

export interface UseNativeBrowserViewOptions {
  viewportRef: RefObject<HTMLElement | null>;
  pageId: string;
  /** The URL the user asked for (not the tracked one): a change navigates the live view. */
  url: string | null;
  /** The page's tab is the visible one. */
  active: boolean;
  /** An overlay (menu, dialog...) must cover the page: the native view is always on top of the DOM. */
  suspended: boolean;
  /** The URL the page is really at: a requested URL equal to it is not navigated to (back/forward, in-page links). */
  currentUrl?: string | null;
  /** Pixels at the bottom of the viewport left free for DOM drawn over it (a toast). */
  insetBottom?: number;
  /** Pixels left free all around the view for a ring drawn in the DOM (an agent controls the page). */
  ring?: number;
  /** Called after every successful show (the view is on screen again). */
  onShown?: () => void;
  /** The backend refused to show or navigate to the address (its reason). */
  onRejected?: (reason: string) => void;
}

/**
 * Keeps the native view of `pageId` over `viewportRef`: shown while
 * active && url, hidden otherwise and on unmount (the view stays alive in the
 * backend, which destroys the least recently shown past 4). While `suspended`
 * (an overlay over it) the view is parked off screen instead of hidden: a
 * hidden WebView2 drops what it drew and comes back white for a few frames,
 * a parked one comes back with the page already painted.
 */
export function useNativeBrowserView({ viewportRef, pageId, url, active, suspended, currentUrl, insetBottom = 0, ring = 0, onShown, onRejected }: UseNativeBrowserViewOptions): void {
  const shownUrl = useRef<string | null>(null);
  const wanted = active && !!url;
  const live = wanted && !suspended;
  const insetRef = useRef(insetBottom);
  insetRef.current = insetBottom;
  const ringRef = useRef(ring);
  ringRef.current = ring;
  const currentRef = useRef(currentUrl);
  currentRef.current = currentUrl;
  const shownCb = useRef(onShown);
  shownCb.current = onShown;
  const rejectedCb = useRef(onRejected);
  rejectedCb.current = onRejected;
  const parkedRef = useRef(suspended);
  parkedRef.current = suspended;
  const kickRef = useRef<(() => void) | null>(null);
  /** Set while the view is shown: moves it on/off screen for `suspended`. */
  const parkRef = useRef<((parked: boolean) => void) | null>(null);

  // Show / hide.
  useEffect(() => {
    const el = viewportRef.current;
    if (!wanted || !el || !url) {
      void nativeView.hide(pageId).catch(() => {});
      return;
    }
    let cancelled = false;
    let last: NativeViewRect | null = null;
    let raf = 0;
    let settle = 0;
    let lastSent = 0;
    let shown = false;

    const tick = () => {
      raf = 0;
      if (cancelled || parkedRef.current) return;
      const r = readRect(el, insetRef.current, ringRef.current);
      if (r && shown && !same(last, r)) {
        const now = performance.now();
        if (now - lastSent >= BOUNDS_INTERVAL_MS) {
          lastSent = now;
          last = r;
          void nativeView.bounds(pageId, r).catch(() => {});
        }
        settle = SETTLE_FRAMES;
      } else if (settle > 0) {
        settle--;
      }
      if (settle > 0 || (r && shown && !same(last, r))) raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (parkedRef.current) return;
      settle = SETTLE_FRAMES;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const park = (parked: boolean) => {
      if (!shown) return;
      if (parked) {
        const r = last ?? readRect(el, insetRef.current, ringRef.current);
        if (r) void nativeView.bounds(pageId, parkedRect(r)).catch(() => {});
        last = null;
        return;
      }
      const r = readRect(el, insetRef.current, ringRef.current);
      if (!r) return;
      last = r;
      void nativeView
        .bounds(pageId, r)
        .then(() => {
          if (cancelled || parkedRef.current) return;
          kick();
          shownCb.current?.();
        })
        .catch(() => {});
    };

    kickRef.current = kick;
    parkRef.current = park;
    const r0 = readRect(el, insetRef.current, ringRef.current);
    if (r0) {
      const parkedAtStart = parkedRef.current;
      last = parkedAtStart ? null : r0;
      void nativeView
        .show(pageId, url, parkedAtStart ? parkedRect(r0) : r0)
        .then(() => {
          if (cancelled) return;
          shown = true;
          shownUrl.current = url;
          // The overlay came or went while the show was on its way.
          if (parkedRef.current !== parkedAtStart) park(parkedRef.current);
          else if (!parkedAtStart) {
            kick();
            shownCb.current?.();
          }
          // A request made while the view was hidden: re-showing never navigates.
          if (currentRef.current && currentRef.current !== url) void nativeView.navigate(pageId, url).catch((e) => rejectedCb.current?.(String(e)));
        })
        .catch((e) => rejectedCb.current?.(String(e)));
    }

    const ro = new ResizeObserver(kick);
    ro.observe(el);
    window.addEventListener("resize", kick);
    // Ancestors scrolling move the rect without resizing it. Captured, so every
    // scroll in the app comes here (a streaming chat scrolls all the time): only
    // a scroller that contains the viewport can move it.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && target !== document && !target.contains(el)) return;
      kick();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelled = true;
      kickRef.current = null;
      parkRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", kick);
      window.removeEventListener("scroll", onScroll, true);
      void nativeView.hide(pageId).catch(() => {});
    };
    // `url` is deliberately not a dependency: a URL change navigates (below)
    // instead of re-showing; `suspended` parks (below) instead of hiding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, pageId, viewportRef]);

  // An overlay came or went: park the view off screen / bring it back.
  useEffect(() => {
    parkRef.current?.(suspended);
  }, [suspended]);

  // The inset changed (toast in / out).
  useEffect(() => {
    kickRef.current?.();
  }, [insetBottom, ring]);

  // The requested URL changed while the view is live.
  useEffect(() => {
    if (!live || !url || shownUrl.current === null || shownUrl.current === url) return;
    shownUrl.current = url;
    // Already there (back/forward, an in-page link): nothing to load.
    if (currentRef.current === url) return;
    void nativeView.navigate(pageId, url).catch((e) => rejectedCb.current?.(String(e)));
  }, [live, pageId, url]);
}

/** The theme's surface as `#rrggbb` (the panels' colour without their transparency). */
function themeSurfaceHex(): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--surface-rgb").trim();
  const parts = raw.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return "#" + parts.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
}

/**
 * Keeps the native views' loading colour on the user's theme: palette, light/dark
 * and contrast all land on :root (attributes or inline vars), so watch those.
 */
export function useNativeThemeBackground(): void {
  useEffect(() => {
    let sent: string | null = null;
    let raf = 0;
    const send = () => {
      raf = 0;
      const hex = themeSurfaceHex();
      if (!hex || hex === sent) return;
      sent = hex;
      void nativeView.theme(hex).catch(() => {});
    };
    send();
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(send);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-palette"] });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}
