import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { basename, parentPath } from "../lib/path";
import { pluginFileUrl } from "../../shared/agentViewBridge";
import { useBrowserSettings } from "./browserSettings";
import { BrowserStatusPage } from "./BrowserStatusPage";
import { focusBrowserDiagnosisTab, openBrowserDiagnosisChat, openBrowserTerminal } from "./browserDiagnosis";
import { portOfUrl } from "./statusPageModel";
import {
  activatePage,
  closePage,
  convertPageToPdf,
  dismissBlockedPage,
  getBrowser,
  goBack,
  goForward,
  isLocalUrl,
  isPdfTarget,
  navigatePage,
  normalizeLocalUrl,
  normalizeTypedUrl,
  openPopupFromPage,
  openUrlInPreview,
  pageLoadFinished,
  pageLoadStarted,
  setBrowserOpen,
  setPageError,
  setPageFavicon,
  setPageTitle,
  setServerAlive,
  syncPageUrl,
  useBrowser,
  type PreviewPage,
} from "./browserStore";
import { nativeView, onNativeError, onNativeLoad, onNativeNavigated, onNativeNewWindow, onNativeTitle, useNativeBrowserView, useNativeThemeBackground } from "./nativeView";
import { useViewportCovered } from "./useViewportCovered";
import { DownloadsBar, DownloadsButton, DownloadsPopover, useDownloads } from "./BrowserDownloads";
import "./browser-panel.css";

const PdfViewer = lazy(() => import("./PdfViewer"));
const ImageFileViewer = lazy(() => import("./ImageFileViewer"));
const isImagePath = (path: string) => /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(path);

/** How often the active artifact's mtime is read for the auto-reload. */
const MTIME_POLL_MS = 1500;
/** How often the detected servers are probed for the live dot. */
const PROBE_POLL_MS = 4000;
/** A page that never reports `loaded` (a dead server) must not leave the bar running. */
const LOAD_TIMEOUT_MS = 20_000;
/** `loading` while the PDF viewer works: not a host load sequence. */
const PDF_LOADING = -1;
/** `loading` while a native page view loads (its own started / finished events). */
const NATIVE_LOADING = -2;
const TOAST_MS = 4000;
/** Strip at the bottom the native view leaves free while the toast shows. */
const TOAST_INSET = 44;
/** The freeze frame is dropped this long after the overlay left, whether or not the view reported back. */
const FREEZE_FALLBACK_MS = 800;

/** Favicon per origin (null: none), so a site is asked once. */
const faviconCache = new Map<string, string | null>();
const faviconPending = new Set<string>();

function requestFavicon(pageId: string, url: string) {
  if (isLocalUrl(url)) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (faviconCache.has(origin)) {
    setPageFavicon(pageId, faviconCache.get(origin) ?? null);
    return;
  }
  if (faviconPending.has(origin)) return;
  faviconPending.add(origin);
  void nativeView
    .favicon(url)
    .catch(() => null)
    .then((icon) => {
      faviconCache.set(origin, icon ?? null);
      faviconPending.delete(origin);
      for (const p of getBrowser().pages) {
        if (p.kind !== "url") continue;
        try {
          if (new URL(p.url).origin === origin) setPageFavicon(p.id, icon ?? null);
        } catch {
          /* not an address */
        }
      }
    });
}

const svg = (children: ReactNode, size?: number) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const GlobeIcon = ({ size }: { size?: number }) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>,
    size,
  );
const BackIcon = () => svg(<path d="M15 18l-6-6 6-6" />);
const ForwardIcon = () => svg(<path d="M9 18l6-6-6-6" />);
const ReloadIcon = () =>
  svg(
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </>,
  );
const ExternalIcon = ({ size }: { size?: number }) =>
  svg(
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>,
    size,
  );
const CloseIcon = ({ size }: { size?: number }) => svg(<path d="M6 6l12 12M18 6L6 18" />, size);
const FileIcon = () =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>,
  );
const ImageIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>);
const PdfIcon = () =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8M12 13v4h.8a2 2 0 0 0 0-4zM16.5 17v-4h1.8" strokeWidth="1.2" />
    </>,
  );
const MoreIcon = () => svg(<path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.6" />);
const CopyIcon = () =>
  svg(
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>,
  );
const DevToolsIcon = () => svg(<path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />);
const TrashIcon = () => svg(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />);
const PopupIcon = () =>
  svg(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
    </>,
  );
const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />);
const ServerIcon = () =>
  svg(
    <>
      <rect x="4" y="4" width="16" height="7" rx="2" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </>,
  );

/** The address split the way the field shows it: a bold part and a muted one. */
function describePage(page: PreviewPage): { bold: string; muted: string; full: string } {
  if (page.kind === "file") return { bold: basename(page.path), muted: parentPath(page.path), full: page.path };
  if (page.kind === "pdf" && !/^https?:\/\//i.test(page.src)) return { bold: basename(page.src), muted: parentPath(page.src), full: page.src };
  const url = page.kind === "pdf" ? page.src : page.url;
  try {
    const u = new URL(url);
    return { bold: u.host, muted: u.pathname + u.search + u.hash, full: url };
  } catch {
    return { bold: url, muted: "", full: url };
  }
}

/** A page's name in the tab list: the file name, or the site plus its last path segment. */
function tabLabel(page: PreviewPage): string {
  if (page.kind === "file") return basename(page.path);
  if (page.kind === "url" && page.title) return page.title;
  if (page.kind === "pdf" && !/^https?:\/\//i.test(page.src)) return basename(page.src);
  const url = page.kind === "pdf" ? page.src : page.url;
  try {
    const u = new URL(url);
    const site = isLocalUrl(url) ? `localhost:${u.port}` : u.hostname.replace(/^www\./, "");
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? `${site} · ${decodeURIComponent(last)}` : site;
  } catch {
    return url;
  }
}

/** A page's badge: the kind icon for files, a server for local addresses, the favicon of a site
 * (a lettered square until it is known). */
function TabBadge({ page }: { page: PreviewPage }) {
  if (page.kind === "file") return <span className="browser-tabs-badge is-icon">{isImagePath(page.path) ? <ImageIcon /> : <FileIcon />}</span>;
  const url = page.kind === "pdf" ? page.src : page.url;
  if (page.kind === "pdf" && !/^https?:\/\//i.test(url)) return <span className="browser-tabs-badge is-icon"><PdfIcon /></span>;
  if (isLocalUrl(url)) return <span className="browser-tabs-badge is-local"><ServerIcon /></span>;
  if (page.kind === "url" && page.favicon) {
    return (
      <span className="browser-tabs-badge is-fav">
        <img src={page.favicon} alt="" draggable={false} />
      </span>
    );
  }
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep the raw text */
  }
  let hue = 0;
  for (const c of host) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="browser-tabs-badge" style={{ background: `hsl(${hue} 42% 64%)` }}>
      {(host[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** A popover next to its button closes on a click elsewhere, on Escape, and when a page frame takes focus
 * (a click inside a frame never reaches this document, it only blurs the window). */
function usePopoverDismiss(open: boolean, close: () => void, popRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLElement | null>) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape also closes the panel when it is an overlay: this one is for the popover only.
      e.stopPropagation();
      closeRef.current();
      buttonRef.current?.focus();
    };
    const onBlur = () => closeRef.current();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, popRef, buttonRef]);
}

/** The preview panel: files, artifacts and PDFs in a sandboxed host page on its own origin
 * (`flowcode-preview://`, so the app's CSP never opens up to the web), web and localhost pages
 * in native child webviews (src/browser/nativeView.ts) that paint above the DOM. */
export function BrowserPanel({ dragging }: { dragging: boolean }) {
  const { pages, activeId, servers } = useBrowser();
  const { artifactScripts, autoReloadArtifacts } = useBrowserSettings();
  const page = pages.find((p) => p.id === activeId) ?? null;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const loadSequence = useRef(0);
  const [readyHost, setReadyHost] = useState<{ url: string; source: Window } | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The typed address opens a new page instead of navigating the current one.
  const [newTab, setNewTab] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsButtonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const downloadItems = useDownloads();
  const [dlOpen, setDlOpen] = useState(false);
  const dlRef = useRef<HTMLDivElement>(null);
  const dlButtonRef = useRef<HTMLButtonElement>(null);
  // The list empties (cleared): its button is gone, so the popover goes with it.
  const dlShown = dlOpen && downloadItems.length > 0;
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // A page opened by another page's popup: the notice with the way back.
  const [toast, setToast] = useState<{ sourceId: string; host: string } | null>(null);
  // An agent was asked to look into a failed page: the notice with the way to its chat.
  const [diagToast, setDiagToast] = useState<{ agent: AgentCli; host: string; tabId: string } | null>(null);
  // "Open in the system browser" failed: the notice with the reason.
  const [openError, setOpenError] = useState<string | null>(null);
  // Pages whose address passed the PDF check (a web page is shown only after it).
  const [checked, setChecked] = useState<string[]>([]);
  const [suspended, setSuspended] = useState(false);
  const [freeze, setFreeze] = useState<{ src: string | null } | null>(null);
  const coverSeq = useRef(0);
  /** The page whose native view is hidden behind the freeze frame. */
  const suspendedFor = useRef<string | null>(null);

  usePopoverDismiss(tabsOpen, () => setTabsOpen(false), tabsRef, tabsButtonRef);
  usePopoverDismiss(menuOpen, () => setMenuOpen(false), menuRef, menuButtonRef);
  usePopoverDismiss(dlShown, () => setDlOpen(false), dlRef, dlButtonRef);
  useEffect(() => {
    if (!menuOpen) setConfirmClear(false);
  }, [menuOpen]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!openError) return;
    const timer = setTimeout(() => setOpenError(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [openError]);
  useEffect(() => {
    if (!diagToast) return;
    const timer = setTimeout(() => setDiagToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [diagToast]);

  // What the native views report. `loading` follows the page in front only.
  useEffect(() => {
    const offs = [
      onNativeNavigated(({ pageId, url }) => syncPageUrl(pageId, url)),
      onNativeTitle(({ pageId, title }) => setPageTitle(pageId, title)),
      onNativeLoad(({ pageId, state, url }) => {
        if (state === "finished") {
          requestFavicon(pageId, url);
          pageLoadFinished(pageId);
        } else pageLoadStarted(pageId);
        if (pageId !== activeIdRef.current) return;
        setLoading((prev) => (state === "started" ? NATIVE_LOADING : prev === NATIVE_LOADING ? null : prev));
      }),
      onNativeError(({ pageId, kind, code, url }) => {
        setPageError(pageId, { kind, code, url });
        if (pageId === activeIdRef.current) setLoading((prev) => (prev === NATIVE_LOADING ? null : prev));
      }),
      onNativeNewWindow(({ pageId, url }) => {
        let host = url;
        try {
          host = new URL(url).host;
        } catch {
          /* show the raw text */
        }
        // A page opening popups in a loop is ignored (see openPopupFromPage).
        if (!openPopupFromPage(pageId, url)) return;
        setToast({ sourceId: pageId, host });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  const hostUrl = pluginFileUrl(convertFileSrc("host", "flowcode-preview"), page?.kind === "file" ? "artifact.html" : "index.html");
  const hostUrlRef = useRef(hostUrl);
  hostUrlRef.current = hostUrl;
  const hostReady = readyHost?.url === hostUrl && readyHost.source === frameRef.current?.contentWindow;

  // Only the host frame may read what we post: its own origin, not "*".
  const hostOrigin = (() => {
    try {
      const u = new URL(hostUrl);
      // A custom scheme (macOS / Linux: flowcode-preview://) has an opaque `origin` in the URL API but
      // a real one in the webview: scheme + host.
      return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  })();
  const post = (message: Record<string, unknown>) => {
    if (hostOrigin) frameRef.current?.contentWindow?.postMessage(message, hostOrigin);
  };

  // The host only talks to its parent, and so do we only to it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const source = frameRef.current?.contentWindow;
      if (!source || e.source !== source) return;
      const message = e.data as { type?: string; sequence?: number } | null;
      const type = message?.type;
      if (type === "ready") setReadyHost({ url: hostUrlRef.current, source });
      else if (type === "loaded" && message?.sequence === loadSequence.current) setLoading(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A url page's address is not part of the key: the native view moves on its own.
  const pageKey = page ? `${page.id}|${page.kind === "url" ? "" : page.kind === "pdf" ? page.src : page.path}` : "";

  useEffect(() => {
    if (!hostReady) return;
    let stale = false;
    const sequence = ++loadSequence.current;
    const current = () => !stale && sequence === loadSequence.current;
    if (!page) {
      post({ type: "clear", sequence });
      setLoading(null);
      return;
    }
    if (page.kind === "pdf" || (page.kind === "file" && isImagePath(page.path))) {
      // The viewer covers the host frame and reports its own loading.
      post({ type: "clear", sequence });
      setLoading((prev) => (prev === PDF_LOADING ? prev : null));
      return;
    }
    if (page.kind === "url") {
      // Web and localhost pages live in native views, not in the host frame.
      post({ type: "clear", sequence });
      setLoading(null);
      return;
    }
    setLoading(sequence);
    void invoke<string>("preview_register_root", { dir: parentPath(page.path) }).then(
      (token) => {
        if (!current()) return;
        const src = `${convertFileSrc("f", "flowcode-preview")}/${token}/${encodeURIComponent(basename(page.path))}`;
        post({ type: "load", sequence, url: src, sandbox: artifactScripts ? "allow-scripts" : "" });
      },
      () => current() && setLoading(null),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, pageKey, reloadNonce, artifactScripts]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      if (loading === loadSequence.current || loading === NATIVE_LOADING) setLoading(null);
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // An agent rewriting the open artifact: reload when the file changes on disk.
  const filePath = page?.kind === "file" ? page.path : page?.kind === "pdf" && !/^https?:\/\//i.test(page.src) ? page.src : null;
  useEffect(() => {
    if (!hostReady || !filePath || !autoReloadArtifacts) return;
    let last: number | null | undefined;
    let busy = false;
    let stale = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const mtime = await invoke<number | null>("preview_file_mtime", { path: filePath });
        if (stale) return;
        // A file missing mid-write says nothing: wait for it to come back.
        if (mtime == null) return;
        if (last !== undefined && mtime !== last) {
          setReloadNonce((n) => n + 1);
        }
        last = mtime;
      } catch {
        /* file momentarily missing mid-write: next tick */
      } finally {
        busy = false;
      }
    }, MTIME_POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, filePath, autoReloadArtifacts]);

  // Liveness of the servers the terminals printed, for the dot on their tab-list rows.
  const hasServers = servers.length > 0;
  const portsRef = useRef<number[]>([]);
  portsRef.current = servers.map((s) => s.port);
  useEffect(() => {
    if (!hasServers) return;
    const probe = () => {
      for (const port of portsRef.current) {
        void invoke<boolean>("preview_probe_port", { port }).then((alive) => setServerAlive(port, alive), () => {});
      }
    };
    probe();
    const timer = setInterval(probe, PROBE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasServers]);

  const reload = () => {
    if (!page) return;
    if (page.kind === "url") {
      void nativeView.reload(page.id).catch(() => {});
      return;
    }
    // Reload uses the same sequence and timeout lifecycle as navigation.
    setReloadNonce((n) => n + 1);
  };

  const openExternal = () => {
    if (!page) return;
    const target = page.kind === "url" ? page.url : page.kind === "pdf" ? page.src : page.path;
    invoke("open_in_system_browser", { target }).catch((e) => setOpenError(String(e)));
  };

  const info = page ? describePage(page) : null;
  const startEditing = () => {
    setNewTab(false);
    setDraft(info?.full ?? "");
    setEditing(true);
  };
  const startNewTab = () => {
    setTabsOpen(false);
    setNewTab(true);
    setDraft("");
    setEditing(true);
  };
  const stopEditing = () => {
    setEditing(false);
    setNewTab(false);
  };
  const commit = () => {
    stopEditing();
    if (!newTab && draft === (info?.full ?? "")) return;
    const typed = normalizeTypedUrl(draft);
    if (!typed) return;
    const url = isLocalUrl(typed) ? normalizeLocalUrl(typed) : typed;
    if (!newTab && page?.kind === "url" && !isPdfTarget(url)) navigatePage(page.id, url);
    else openUrlInPreview(url);
  };

  // Detected servers not already shown as a page (same port on a local address).
  const openPorts = new Set(
    pages.flatMap((p) => {
      if (p.kind !== "url" || !isLocalUrl(p.url)) return [];
      try {
        return [Number(new URL(p.url).port)];
      } catch {
        return [];
      }
    }),
  );
  const freeServers = servers.filter((s) => !openPorts.has(s.port));

  const urlPage = page?.kind === "url" ? page : null;
  const urlId = urlPage?.id ?? null;
  const requestedUrl = urlPage?.requestedUrl ?? null;

  // A web page is shown only once its address is known not to be a PDF (the PDF viewer takes those).
  useEffect(() => {
    if (!urlId || !requestedUrl) return;
    const markChecked = () => setChecked((c) => (c.includes(urlId) ? c : [...c, urlId]));
    if (isLocalUrl(requestedUrl)) {
      markChecked();
      return;
    }
    let stale = false;
    invoke<{ blocked: boolean; pdf: boolean }>("preview_frame_check", { url: requestedUrl }).then(
      ({ pdf }) => {
        if (stale) return;
        if (pdf) convertPageToPdf(urlId, requestedUrl);
        else markChecked();
      },
      // The check itself failing says nothing about the site: show it.
      () => !stale && markChecked(),
    );
    return () => {
      stale = true;
    };
  }, [urlId, requestedUrl]);

  // The native view is above the DOM: while an overlay covers the viewport (a menu, a dialog, this
  // panel's own popovers) a snapshot stands in for the page and the view is hidden.
  const { visible, covered } = useViewportCovered(viewportRef, !dragging);
  const coverNow = covered || tabsOpen || menuOpen || dlShown;
  // Shown only after the PDF check, except pages already shown (a later navigation is checked alongside).
  const nativeUrl = urlPage && (checked.includes(urlPage.id) || isLocalUrl(urlPage.requestedUrl)) ? urlPage.requestedUrl : null;
  // A failed page is shown by us instead: the native view stays hidden until a load works again.
  const nativeLive = !!urlPage && visible && !!nativeUrl && !urlPage.error;
  const insetBottom = (toast || diagToast || openError) && urlPage ? TOAST_INSET : 0;

  useNativeThemeBackground();
  useNativeBrowserView({
    viewportRef,
    pageId: urlId ?? "",
    url: nativeUrl,
    active: nativeLive,
    suspended,
    currentUrl: urlPage?.url ?? null,
    insetBottom,
    // The backend refuses the app's own addresses: our blocked page says so.
    onRejected: (reason) => {
      if (urlId && nativeUrl && /reserved app host|dev server cannot be opened/i.test(reason)) setPageError(urlId, { kind: "blocked", code: "BLOCKED_LOCAL_ORIGIN", url: nativeUrl });
    },
    onShown: () =>
      requestAnimationFrame(() => {
        if (suspendedFor.current === null) setFreeze(null);
      }),
  });

  useEffect(() => {
    const mine = ++coverSeq.current;
    if (!coverNow) {
      suspendedFor.current = null;
      setSuspended(false);
      return;
    }
    // Nothing to hide, a snapshot already stands in, or a panel drag is moving the view.
    if (!nativeLive || !urlId || suspendedFor.current === urlId || dragging) return;
    // A stale answer (the overlay left, another page came forward) is dropped by its sequence.
    const stand = (src: string | null) => {
      if (coverSeq.current !== mine) return;
      suspendedFor.current = urlId;
      setFreeze({ src });
      setSuspended(true);
    };
    nativeView.snapshot(urlId).then(stand, () => stand(null));
  }, [coverNow, nativeLive, urlId, dragging]);

  // The view reports back (onShown) in the normal case; this covers a view that never shows again.
  useEffect(() => {
    if (!freeze || coverNow) return;
    const timer = setTimeout(() => setFreeze(null), FREEZE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [freeze, coverNow]);

  const copyAddress = () => {
    if (info) void navigator.clipboard.writeText(info.full).catch(() => {});
  };
  const clearSession = () => {
    if (!urlId) return;
    void nativeView
      .clearData(urlId)
      .then(() => nativeView.reload(urlId))
      .catch(() => {});
  };
  // The folder of a diagnosis or a terminal opened from a failed page follows the dev server's terminal, or the tab it was opened for.
  const hintTabId = () => {
    if (!urlPage) return undefined;
    const port = Number(portOfUrl(urlPage.error?.url ?? urlPage.url));
    return (isLocalUrl(urlPage.url) ? servers.find((s) => s.port === port)?.tabId : undefined) ?? urlPage.fromTabId;
  };
  const leaveErrorPage = () => {
    if (!urlPage?.error) return;
    if (urlPage.error.kind === "blocked") dismissBlockedPage(urlPage.id);
    else if (urlPage.back.length > 0) goBack(urlPage.id);
    else closePage(urlPage.id);
  };
  const diagnose = (agent: AgentCli, prompt: string, host: string) =>
    openBrowserDiagnosisChat({
      agent,
      prompt,
      label: t("browser.page.chatLabel", { host }),
      hintTabId: hintTabId(),
      onOpened: (tabId) => setDiagToast({ agent, host, tabId }),
    });
  const toastSourceOpen = !!toast && pages.some((p) => p.id === toast.sourceId);

  return (
    <div className="browser-panel">
      <div className="browser-panel-header">
        <button type="button" className="icon-button sm" disabled={!urlPage || urlPage.back.length === 0} onClick={() => urlPage && goBack(urlPage.id)} title={t("browser.back")} aria-label={t("browser.back")}>
          <BackIcon />
        </button>
        <button type="button" className="icon-button sm" disabled={!urlPage || urlPage.forward.length === 0} onClick={() => urlPage && goForward(urlPage.id)} title={t("browser.forward")} aria-label={t("browser.forward")}>
          <ForwardIcon />
        </button>
        <button type="button" className="icon-button sm" disabled={!page} onClick={reload} title={t("browser.reload")} aria-label={t("browser.reload")}>
          <ReloadIcon />
        </button>
        {editing ? (
          <input
            className="browser-panel-url-input"
            autoFocus
            spellCheck={false}
            value={draft}
            placeholder={t("browser.address.placeholder")}
            aria-label={t("browser.address")}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={stopEditing}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") {
                // Escape also closes the panel when it is an overlay: this one is for the field only.
                e.stopPropagation();
                stopEditing();
              }
            }}
          />
        ) : (
          <button type="button" className="browser-panel-url" onClick={startEditing} title={info?.full ?? t("browser.address")} aria-label={t("browser.address")}>
            {page?.kind === "file" ? isImagePath(page.path) ? <ImageIcon /> : <FileIcon /> : page?.kind === "pdf" ? <PdfIcon /> : <GlobeIcon />}
            {info ? (
              <>
                <span className="browser-panel-url-host">{info.bold}</span>
                <span className="browser-panel-url-path">{info.muted}</span>
              </>
            ) : (
              <span className="browser-panel-url-path">{t("browser.address.placeholder")}</span>
            )}
          </button>
        )}
        <DownloadsButton
          items={downloadItems}
          open={dlShown}
          buttonRef={dlButtonRef}
          onToggle={() => {
            setMenuOpen(false);
            setTabsOpen(false);
            setDlOpen((o) => !o);
          }}
        />
        <button
          ref={tabsButtonRef}
          type="button"
          className={"browser-tabs-button" + (tabsOpen ? " is-open" : "")}
          onClick={() => {
            setMenuOpen(false);
            setDlOpen(false);
            setTabsOpen((o) => !o);
          }}
          title={t("browser.tabs")}
          aria-label={t("browser.tabs")}
          aria-haspopup="true"
          aria-expanded={tabsOpen}
        >
          <span className="browser-tabs-count">{pages.length}</span>
          {freeServers.some((s) => s.alive) && <span className="browser-panel-dot is-alive browser-tabs-signal" />}
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          className={"icon-button sm" + (menuOpen ? " is-open" : "")}
          disabled={!page}
          onClick={() => {
            setTabsOpen(false);
            setDlOpen(false);
            setMenuOpen((o) => !o);
          }}
          title={t("browser.more")}
          aria-label={t("browser.more")}
          aria-haspopup="true"
          aria-expanded={menuOpen}
        >
          <MoreIcon />
        </button>
        <button type="button" className="icon-button sm" onClick={() => setBrowserOpen(false)} title={t("browser.close")} aria-label={t("browser.close")}>
          <CloseIcon />
        </button>
      </div>

      <DownloadsBar items={downloadItems} />

      <div ref={viewportRef} className={"browser-panel-viewport" + (dragging ? " is-dragging" : "") + (page ? " has-page" : "")}>
        {loading && <div className="browser-panel-loadbar" />}
        <iframe key={hostUrl} ref={frameRef} className="browser-panel-frame" src={hostUrl} title={t("browser.title")} />
        {page?.kind === "pdf" && (
          <Suspense fallback={null}>
            <PdfViewer src={page.src} reloadNonce={reloadNonce} onLoading={(busy) => setLoading(busy ? PDF_LOADING : null)} onOpenExternal={openExternal} />
          </Suspense>
        )}
        {page?.kind === "file" && isImagePath(page.path) && (
          <Suspense fallback={null}>
            <ImageFileViewer key={page.path} path={page.path} reloadNonce={reloadNonce} onLoading={(busy) => setLoading(busy ? PDF_LOADING : null)} />
          </Suspense>
        )}
        {(!page || urlPage?.error) && (
          <BrowserStatusPage
            failure={urlPage?.error ? { pageId: urlPage.id, error: urlPage.error, retrying: !!urlPage.retrying } : null}
            servers={servers}
            onReload={reload}
            onBack={leaveErrorPage}
            onOpenExternal={openExternal}
            onOpenTerminal={() => openBrowserTerminal({ hintTabId: hintTabId() })}
            onOpenUrl={(url) => openUrlInPreview(url)}
            onDiagnose={diagnose}
          />
        )}
        {urlPage && freeze?.src && <img className="browser-panel-freeze" src={freeze.src} alt="" draggable={false} style={{ height: `calc(100% - ${insetBottom}px)` }} />}
        {urlPage && freeze && !freeze.src && (
          <div className="browser-panel-pause">
            <div className="browser-panel-pause-chip">
              <i />
              {t("browser.freeze.paused")}
            </div>
          </div>
        )}
        {openError && (
          <div className="browser-panel-toast" data-cover-ignore role="alert">
            <span>{t("browser.openExternalFailed", { error: openError })}</span>
          </div>
        )}
        {diagToast && !openError && (
          <div className="browser-panel-toast" data-cover-ignore role="status">
            <PopupIcon />
            <span>{t("browser.toast.diagnosing", { agent: cliName(diagToast.agent), host: diagToast.host })}</span>
            <button
              type="button"
              className="browser-panel-toast-link"
              onClick={() => {
                focusBrowserDiagnosisTab(diagToast.tabId);
                setDiagToast(null);
              }}
            >
              {t("browser.toast.openChat")}
            </button>
          </div>
        )}
        {toast && !diagToast && !openError && (
          <div className="browser-panel-toast" data-cover-ignore role="status">
            <PopupIcon />
            <span>{t("browser.toast.newTab", { host: toast.host })}</span>
            {toastSourceOpen && (
              <button
                type="button"
                className="browser-panel-toast-link"
                onClick={() => {
                  activatePage(toast.sourceId);
                  setToast(null);
                }}
              >
                {t("browser.toast.back")}
              </button>
            )}
          </div>
        )}
      </div>

      {menuOpen && (
        <div ref={menuRef} className="browser-tabs-pop browser-menu-pop" role="menu" aria-label={t("browser.more")}>
          <button type="button" role="menuitem" className="browser-menu-item" onClick={() => { setMenuOpen(false); openExternal(); }}>
            <ExternalIcon />
            {t("browser.openExternal")}
          </button>
          <button type="button" role="menuitem" className="browser-menu-item" onClick={() => { setMenuOpen(false); copyAddress(); }}>
            <CopyIcon />
            {t("browser.menu.copy")}
          </button>
          <div className="browser-tabs-sep" />
          <button type="button" role="menuitem" className="browser-menu-item" disabled={!urlPage} onClick={() => { setMenuOpen(false); if (urlId) void nativeView.devtools(urlId).catch(() => {}); }}>
            <DevToolsIcon />
            {t("browser.menu.devtools")}
            <span className="browser-menu-key">F12</span>
          </button>
          <button type="button" role="menuitem" className="browser-menu-item" disabled={!urlPage} onClick={() => { setMenuOpen(false); if (urlId) void nativeView.reload(urlId, true).catch(() => {}); }}>
            <ReloadIcon />
            {t("browser.menu.hardReload")}
            <span className="browser-menu-key">Ctrl+Shift+R</span>
          </button>
          <div className="browser-tabs-sep" />
          <div className="browser-tabs-heading">{t("browser.menu.session")}</div>
          {confirmClear ? (
            <>
              <button type="button" role="menuitem" className="browser-menu-item is-danger is-confirm" onClick={() => { setMenuOpen(false); clearSession(); }}>
                <TrashIcon />
                {t("browser.menu.clearConfirm")}
              </button>
              <button type="button" role="menuitem" className="browser-menu-item is-plain" onClick={() => setConfirmClear(false)}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" className="browser-menu-item is-danger" disabled={!urlPage} onClick={() => setConfirmClear(true)}>
              <TrashIcon />
              {t("browser.menu.clear")}
            </button>
          )}
          <div className="browser-menu-note">{t("browser.menu.sessionNote")}</div>
        </div>
      )}

      {dlShown && <DownloadsPopover items={downloadItems} popRef={dlRef} close={() => setDlOpen(false)} />}

      {tabsOpen && (
        <div ref={tabsRef} className="browser-tabs-pop" role="dialog" aria-label={t("browser.tabs")}>
          {pages.length > 0 && (
            <>
              <div className="browser-tabs-heading">{`${t("browser.tabs")} · ${pages.length}`}</div>
              {pages.map((p) => (
                <div key={p.id} className={"browser-tabs-row" + (p.id === activeId ? " is-active" : "")}>
                  <button
                    type="button"
                    className="browser-tabs-row-main"
                    onClick={() => {
                      activatePage(p.id);
                      setTabsOpen(false);
                    }}
                    title={describePage(p).full}
                    aria-current={p.id === activeId ? "page" : undefined}
                  >
                    <TabBadge page={p} />
                    <span className="browser-tabs-row-text">
                      <span className="browser-tabs-row-title">{tabLabel(p)}</span>
                      <span className="browser-tabs-row-sub">{describePage(p).full}</span>
                    </span>
                  </button>
                  <button type="button" className="browser-tabs-row-x" onClick={() => closePage(p.id)} title={t("browser.closePage")} aria-label={t("browser.closePage")}>
                    <CloseIcon size={10} />
                  </button>
                </div>
              ))}
            </>
          )}
          {freeServers.length > 0 && (
            <>
              {pages.length > 0 && <div className="browser-tabs-sep" />}
              <div className="browser-tabs-heading">{t("browser.tabs.servers")}</div>
              {freeServers.map((s) => (
                <div key={s.port} className="browser-tabs-row">
                  <span className="browser-tabs-row-main is-static">
                    <span className="browser-tabs-badge is-server">
                      <span className={"browser-panel-dot" + (s.alive ? " is-alive" : "")} />
                    </span>
                    <span className="browser-tabs-row-text">
                      <span className="browser-tabs-row-title">{`localhost:${s.port}`}</span>
                      <span className="browser-tabs-row-sub">{t(s.alive ? "browser.tabs.serverAlive" : "browser.tabs.serverDown")}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="browser-tabs-open"
                    onClick={() => {
                      openUrlInPreview(s.url);
                      setTabsOpen(false);
                    }}
                    title={s.url}
                  >
                    {t("browser.tabs.openServer")}
                  </button>
                </div>
              ))}
            </>
          )}
          {(pages.length > 0 || freeServers.length > 0) && <div className="browser-tabs-sep" />}
          <button type="button" className="browser-tabs-new" onClick={startNewTab}>
            <PlusIcon />
            {t("browser.tabs.new")}
          </button>
        </div>
      )}
    </div>
  );
}
