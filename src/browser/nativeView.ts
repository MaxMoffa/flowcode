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

export const nativeView = {
  show: (pageId: string, url: string, r: NativeViewRect) => invoke<void>("browser_view_show", { pageId, url, ...r }),
  bounds: (pageId: string, r: NativeViewRect) => invoke<void>("browser_view_bounds", { pageId, ...r }),
  /** One page, or every child of this window when `pageId` is omitted. */
  hide: (pageId?: string) => invoke<void>("browser_view_hide", { pageId: pageId ?? null }),
  navigate: (pageId: string, url: string) => invoke<void>("browser_view_navigate", { pageId, url }),
  back: (pageId: string) => invoke<void>("browser_view_back", { pageId }),
  forward: (pageId: string) => invoke<void>("browser_view_forward", { pageId }),
  reload: (pageId: string, ignoreCache = false) => invoke<void>("browser_view_reload", { pageId, ignoreCache }),
  close: (pageId: string) => invoke<void>("browser_view_close", { pageId }),
  devtools: (pageId: string) => invoke<void>("browser_view_devtools", { pageId }),
  /** Clears cookies/storage of the shared browser profile (needs a live view for `pageId`). */
  clearData: (pageId: string) => invoke<void>("browser_view_clear_data", { pageId }),
  /** PNG data URL of what the view shows now (Windows only; null elsewhere or when the capture failed). */
  snapshot: (pageId: string) => invoke<string | null>("browser_view_snapshot", { pageId }),
  /** `<origin>/favicon.ico` of a public site as a data URL, or null. */
  favicon: (url: string) => invoke<string | null>("browser_favicon", { url }),
  /** Whether something listens at a loopback address (TCP connect, 700 ms). Rejects for any other host. */
  probeLocal: (url: string) => invoke<boolean>("browser_probe_local", { url }),
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
export interface NativeDownload {
  pageId: string;
  url: string;
  path: string | null;
  /** null while the download is only requested; set when it finished. */
  success: boolean | null;
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
export const onNativeDownload = (cb: (p: NativeDownload) => void) => sub("browser-view-download", cb);

function readRect(el: HTMLElement, insetBottom: number): NativeViewRect | null {
  const b = el.getBoundingClientRect();
  const height = b.height - insetBottom;
  if (b.width < 1 || height < 1) return null;
  return { x: b.left, y: b.top, width: b.width, height };
}

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
  /** Called after every successful show (the view is on screen again). */
  onShown?: () => void;
  /** The backend refused to show or navigate to the address (its reason). */
  onRejected?: (reason: string) => void;
}

/**
 * Keeps the native view of `pageId` over `viewportRef`: shown while
 * active && !suspended && url, hidden otherwise and on unmount (the view stays
 * alive in the backend, which destroys the least recently shown past 4).
 */
export function useNativeBrowserView({ viewportRef, pageId, url, active, suspended, currentUrl, insetBottom = 0, onShown, onRejected }: UseNativeBrowserViewOptions): void {
  const shownUrl = useRef<string | null>(null);
  const live = active && !suspended && !!url;
  const insetRef = useRef(insetBottom);
  insetRef.current = insetBottom;
  const currentRef = useRef(currentUrl);
  currentRef.current = currentUrl;
  const shownCb = useRef(onShown);
  shownCb.current = onShown;
  const rejectedCb = useRef(onRejected);
  rejectedCb.current = onRejected;
  const kickRef = useRef<(() => void) | null>(null);

  // Show / hide.
  useEffect(() => {
    const el = viewportRef.current;
    if (!live || !el || !url) {
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
      if (cancelled) return;
      const r = readRect(el, insetRef.current);
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
      settle = SETTLE_FRAMES;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    kickRef.current = kick;
    const r0 = readRect(el, insetRef.current);
    if (r0) {
      last = r0;
      void nativeView
        .show(pageId, url, r0)
        .then(() => {
          shown = true;
          shownUrl.current = url;
          kick();
          shownCb.current?.();
          // A request made while the view was hidden: re-showing never navigates.
          if (currentRef.current && currentRef.current !== url) void nativeView.navigate(pageId, url).catch((e) => rejectedCb.current?.(String(e)));
        })
        .catch((e) => rejectedCb.current?.(String(e)));
    }

    const ro = new ResizeObserver(kick);
    ro.observe(el);
    window.addEventListener("resize", kick);
    // Ancestors scrolling or panels animating move the rect without resizing it.
    window.addEventListener("scroll", kick, true);
    return () => {
      cancelled = true;
      kickRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", kick);
      window.removeEventListener("scroll", kick, true);
      void nativeView.hide(pageId).catch(() => {});
    };
    // `url` is deliberately not a dependency: a URL change navigates (below)
    // instead of re-showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, pageId, viewportRef]);

  // The inset changed (toast in / out).
  useEffect(() => {
    kickRef.current?.();
  }, [insetBottom]);

  // The requested URL changed while the view is live.
  useEffect(() => {
    if (!live || !url || shownUrl.current === null || shownUrl.current === url) return;
    shownUrl.current = url;
    // Already there (back/forward, an in-page link): nothing to load.
    if (currentRef.current === url) return;
    void nativeView.navigate(pageId, url).catch((e) => rejectedCb.current?.(String(e)));
  }, [live, pageId, url]);
}
