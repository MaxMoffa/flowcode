import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { basename, parentPath } from "../lib/path";
import { pluginFileUrl } from "../../shared/agentViewBridge";
import { useBrowserSettings } from "./browserSettings";
import {
  activatePage,
  closePage,
  convertPageToPdf,
  goBack,
  goForward,
  isLocalUrl,
  isPdfTarget,
  navigatePage,
  normalizeLocalUrl,
  normalizeTypedUrl,
  openUrlInPreview,
  setBrowserOpen,
  setServerAlive,
  useBrowser,
  type PreviewPage,
} from "./browserStore";
import "./browser-panel.css";

const PdfViewer = lazy(() => import("./PdfViewer"));

/** Sandbox of the page inside the host frame. A web page keeps its origin
 * (a dev server needs its own cookies and storage) but never gets popups or
 * top navigation. */
const WEB_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";
/** How often the active artifact's mtime is read for the auto-reload. */
const MTIME_POLL_MS = 1500;
/** How often the detected servers are probed for the live dot. */
const PROBE_POLL_MS = 4000;
/** A page that never reports `loaded` (a dead server) must not leave the bar running. */
const LOAD_TIMEOUT_MS = 20_000;
/** `loading` while the PDF viewer works: not a host load sequence. */
const PDF_LOADING = -1;

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
const PdfIcon = () =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8M12 13v4h.8a2 2 0 0 0 0-4zM16.5 17v-4h1.8" strokeWidth="1.2" />
    </>,
  );
const ShieldIcon = () => svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />);
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

/** A page's badge: the kind icon for files, a server for local addresses, a lettered square for sites
 * (a cross-origin frame hides the real title and favicon). */
function TabBadge({ page }: { page: PreviewPage }) {
  if (page.kind === "file") return <span className="browser-tabs-badge is-icon"><FileIcon /></span>;
  const url = page.kind === "pdf" ? page.src : page.url;
  if (page.kind === "pdf" && !/^https?:\/\//i.test(url)) return <span className="browser-tabs-badge is-icon"><PdfIcon /></span>;
  if (isLocalUrl(url)) return <span className="browser-tabs-badge is-local"><ServerIcon /></span>;
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

/** The sandboxed artifact/dev-server preview: a host page on its own origin
 * (`flowcode-preview://`) that holds the real page in an inner iframe, so the
 * app's CSP never has to open up to the web. All this panel does is tell the
 * host what to load. */
export function BrowserPanel({ dragging }: { dragging: boolean }) {
  const { pages, activeId, servers } = useBrowser();
  const { artifactScripts, autoReloadArtifacts } = useBrowserSettings();
  const page = pages.find((p) => p.id === activeId) ?? null;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const loadSequence = useRef(0);
  const [readyHost, setReadyHost] = useState<{ url: string; source: Window } | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The typed address opens a new page instead of navigating the current one.
  const [newTab, setNewTab] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsButtonRef = useRef<HTMLButtonElement>(null);

  // The tab list closes on a click elsewhere, on Escape, and when the page frame takes focus
  // (a click inside an iframe never reaches this document, it only blurs the window).
  useEffect(() => {
    if (!tabsOpen) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (tabsRef.current?.contains(target) || tabsButtonRef.current?.contains(target)) return;
      setTabsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape also closes the panel when it is an overlay: this one is for the list only.
      e.stopPropagation();
      setTabsOpen(false);
      tabsButtonRef.current?.focus();
    };
    const onBlur = () => setTabsOpen(false);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [tabsOpen]);

  const hostUrl = pluginFileUrl(convertFileSrc("host", "flowcode-preview"), page?.kind === "file" ? "artifact.html" : "index.html");
  const hostUrlRef = useRef(hostUrl);
  hostUrlRef.current = hostUrl;
  const hostReady = readyHost?.url === hostUrl && readyHost.source === frameRef.current?.contentWindow;

  const post = (message: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(message, "*");

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

  const pageKey = page ? `${page.id}|${page.kind === "url" ? page.url : page.kind === "pdf" ? page.src : page.path}` : "";

  useEffect(() => {
    if (!hostReady) return;
    let stale = false;
    const sequence = ++loadSequence.current;
    const current = () => !stale && sequence === loadSequence.current;
    setBlockedUrl(null);
    if (!page) {
      post({ type: "clear", sequence });
      setLoading(null);
      return;
    }
    if (page.kind === "pdf") {
      // The viewer covers the host frame and reports its own loading.
      post({ type: "clear", sequence });
      setLoading((prev) => (prev === PDF_LOADING ? prev : null));
      return;
    }
    setLoading(sequence);
    if (page.kind === "file") {
      void invoke<string>("preview_register_root", { dir: parentPath(page.path) }).then(
        (token) => {
          if (!current()) return;
          const src = `${convertFileSrc("f", "flowcode-preview")}/${token}/${encodeURIComponent(basename(page.path))}`;
          post({ type: "load", sequence, url: src, sandbox: artifactScripts ? "allow-scripts" : "" });
        },
        () => current() && setLoading(null),
      );
    } else if (isLocalUrl(page.url)) {
      post({ type: "load", sequence, url: page.url, sandbox: WEB_SANDBOX });
    } else {
      // An iframe doesn't report X-Frame-Options / CSP refusals, so ask first.
      void invoke<{ blocked: boolean; pdf: boolean }>("preview_frame_check", { url: page.url }).then(
        ({ blocked, pdf }) => {
          if (!current()) return;
          if (pdf) {
            convertPageToPdf(page.id, page.url);
            setLoading(null);
          } else if (blocked) {
            post({ type: "clear", sequence });
            setBlockedUrl(page.url);
            setLoading(null);
          } else post({ type: "load", sequence, url: page.url, sandbox: WEB_SANDBOX });
        },
        // The check itself failing says nothing about the site: try it.
        () => current() && post({ type: "load", sequence, url: page.url, sandbox: WEB_SANDBOX }),
      );
    }
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, pageKey, reloadNonce, artifactScripts]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      if (loading === loadSequence.current) setLoading(null);
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
    // Reload uses the same sequence and timeout lifecycle as navigation.
    setReloadNonce((n) => n + 1);
  };

  const openExternal = () => {
    if (!page) return;
    if (page.kind === "url") void openUrl(page.url);
    else if (page.kind === "pdf" && /^https?:\/\//i.test(page.src)) void openUrl(page.src);
    else void invoke("open_with_default_app", { path: page.kind === "pdf" ? page.src : page.path });
  };

  const copyBlockedLink = () => {
    if (!blockedUrl) return;
    void navigator.clipboard.writeText(blockedUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
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
            {page?.kind === "file" ? <FileIcon /> : page?.kind === "pdf" ? <PdfIcon /> : <GlobeIcon />}
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
        <button
          ref={tabsButtonRef}
          type="button"
          className={"browser-tabs-button" + (tabsOpen ? " is-open" : "")}
          onClick={() => setTabsOpen((o) => !o)}
          title={t("browser.tabs")}
          aria-label={t("browser.tabs")}
          aria-haspopup="true"
          aria-expanded={tabsOpen}
        >
          <span className="browser-tabs-count">{pages.length}</span>
          {freeServers.some((s) => s.alive) && <span className="browser-panel-dot is-alive browser-tabs-signal" />}
        </button>
        <button type="button" className="icon-button sm" disabled={!page} onClick={openExternal} title={t("browser.openExternal")} aria-label={t("browser.openExternal")}>
          <ExternalIcon />
        </button>
        <button type="button" className="icon-button sm" onClick={() => setBrowserOpen(false)} title={t("browser.close")} aria-label={t("browser.close")}>
          <CloseIcon />
        </button>
      </div>

      <div className={"browser-panel-viewport" + (dragging ? " is-dragging" : "") + (page ? " has-page" : "")}>
        {loading && <div className="browser-panel-loadbar" />}
        <iframe key={hostUrl} ref={frameRef} className="browser-panel-frame" src={hostUrl} title={t("browser.title")} />
        {page?.kind === "pdf" && (
          <Suspense fallback={null}>
            <PdfViewer src={page.src} reloadNonce={reloadNonce} onLoading={(busy) => setLoading(busy ? PDF_LOADING : null)} onOpenExternal={openExternal} />
          </Suspense>
        )}
        {!page && (
          <div className="browser-panel-state">
            <div className="browser-panel-state-icon">
              <GlobeIcon size={20} />
            </div>
            <h4>{t("browser.empty.title")}</h4>
            <p>{t("browser.empty.hint")}</p>
          </div>
        )}
        {blockedUrl && (
          <div className="browser-panel-state">
            <div className="browser-panel-state-icon">
              <ShieldIcon />
            </div>
            <h4>{t("browser.blocked.title")}</h4>
            <p>{t("browser.blocked.text", { host: new URL(blockedUrl).host })}</p>
            <div className="browser-panel-state-actions">
              <button type="button" className="browser-panel-btn is-primary" onClick={() => void openUrl(blockedUrl)}>
                <ExternalIcon size={13} />
                {t("browser.blocked.open")}
              </button>
              <button type="button" className="browser-panel-btn" onClick={copyBlockedLink}>
                {copied ? t("common.copied") : t("browser.blocked.copy")}
              </button>
            </div>
          </div>
        )}
      </div>

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
