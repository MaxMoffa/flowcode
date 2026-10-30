import { useEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { basename, parentPath } from "../lib/path";
import { pluginFileUrl } from "../../shared/agentViewBridge";
import { useBrowserSettings } from "./browserSettings";
import {
  activatePage,
  closePage,
  goBack,
  goForward,
  isLocalUrl,
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
const ShieldIcon = () => svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />);

/** The address split the way the field shows it: a bold part and a muted one. */
function describePage(page: PreviewPage): { bold: string; muted: string; full: string } {
  if (page.kind === "file") return { bold: basename(page.path), muted: parentPath(page.path), full: page.path };
  try {
    const u = new URL(page.url);
    return { bold: u.host, muted: u.pathname + u.search + u.hash, full: page.url };
  } catch {
    return { bold: page.url, muted: "", full: page.url };
  }
}

function chipLabel(page: PreviewPage): string {
  if (page.kind === "file") return basename(page.path);
  const { bold, muted } = describePage(page);
  return muted === "/" ? bold : bold + muted;
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
  const [hostReady, setHostReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const hostUrl = pluginFileUrl(convertFileSrc("host", "flowcode-preview"), "index.html");

  const post = (message: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(message, "*");

  // The host only talks to its parent, and so do we only to it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "ready") setHostReady(true);
      else if (type === "loaded") setLoading(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const pageKey = page ? (page.kind === "url" ? `${page.id}|${page.url}` : `${page.id}|${page.path}`) : "";

  useEffect(() => {
    if (!hostReady) return;
    let stale = false;
    setBlockedUrl(null);
    if (!page) {
      post({ type: "clear" });
      setLoading(false);
      return;
    }
    setLoading(true);
    if (page.kind === "file") {
      void invoke<string>("preview_register_root", { dir: parentPath(page.path) }).then(
        (token) => {
          if (stale) return;
          const src = `${convertFileSrc("f", "flowcode-preview")}/${token}/${encodeURIComponent(basename(page.path))}`;
          post({ type: "load", url: src, sandbox: artifactScripts ? "allow-scripts" : "" });
        },
        () => !stale && setLoading(false),
      );
    } else if (isLocalUrl(page.url)) {
      post({ type: "load", url: page.url, sandbox: WEB_SANDBOX });
    } else {
      // An iframe doesn't report X-Frame-Options / CSP refusals, so ask first.
      void invoke<{ blocked: boolean }>("preview_frame_check", { url: page.url }).then(
        ({ blocked }) => {
          if (stale) return;
          if (blocked) {
            post({ type: "clear" });
            setBlockedUrl(page.url);
            setLoading(false);
          } else post({ type: "load", url: page.url, sandbox: WEB_SANDBOX });
        },
        // The check itself failing says nothing about the site: try it.
        () => !stale && post({ type: "load", url: page.url, sandbox: WEB_SANDBOX }),
      );
    }
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, pageKey, reloadNonce, artifactScripts]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // An agent rewriting the open artifact: reload when the file changes on disk.
  const filePath = page?.kind === "file" ? page.path : null;
  useEffect(() => {
    if (!hostReady || !filePath || !autoReloadArtifacts) return;
    let last: number | null | undefined;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const mtime = await invoke<number | null>("preview_file_mtime", { path: filePath });
        if (last !== undefined && mtime !== last) {
          setLoading(true);
          post({ type: "reload" });
        }
        last = mtime;
      } catch {
        /* file momentarily missing mid-write: next tick */
      } finally {
        busy = false;
      }
    }, MTIME_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostReady, filePath, autoReloadArtifacts]);

  // Liveness of the servers the terminals printed, for the dot on their chips.
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
    if (blockedUrl) {
      setReloadNonce((n) => n + 1);
      return;
    }
    setLoading(true);
    post({ type: "reload" });
  };

  const openExternal = () => {
    if (!page) return;
    if (page.kind === "url") void openUrl(page.url);
    else void invoke("open_with_default_app", { path: page.path });
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
    setDraft(info?.full ?? "");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft === (info?.full ?? "")) return;
    const typed = normalizeTypedUrl(draft);
    if (!typed) return;
    const url = isLocalUrl(typed) ? normalizeLocalUrl(typed) : typed;
    if (page?.kind === "url") navigatePage(page.id, url);
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
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") {
                // Escape also closes the panel when it is an overlay: this one is for the field only.
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="browser-panel-url" onClick={startEditing} title={info?.full ?? t("browser.address")} aria-label={t("browser.address")}>
            {page?.kind === "file" ? <FileIcon /> : <GlobeIcon />}
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
        <button type="button" className="icon-button sm" disabled={!page} onClick={openExternal} title={t("browser.openExternal")} aria-label={t("browser.openExternal")}>
          <ExternalIcon />
        </button>
        <button type="button" className="icon-button sm" onClick={() => setBrowserOpen(false)} title={t("browser.close")} aria-label={t("browser.close")}>
          <CloseIcon />
        </button>
      </div>

      {(pages.length > 0 || freeServers.length > 0) && (
        <div className="browser-panel-chips">
          {pages.map((p) => (
            <span key={p.id} className={"browser-panel-chip" + (p.id === activeId ? " is-active" : "")}>
              <button type="button" className="browser-panel-chip-main" onClick={() => activatePage(p.id)} title={describePage(p).full}>
                {p.kind === "file" && <FileIcon />}
                <span className="browser-panel-chip-label">{chipLabel(p)}</span>
              </button>
              <button type="button" className="browser-panel-chip-x" onClick={() => closePage(p.id)} title={t("browser.closePage")} aria-label={t("browser.closePage")}>
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
          {freeServers.map((s) => (
            <button key={s.port} type="button" className="browser-panel-chip browser-panel-chip-main" onClick={() => openUrlInPreview(s.url)} title={s.url}>
              <span className={"browser-panel-dot" + (s.alive ? " is-alive" : "")} />
              <span className="browser-panel-chip-label">{`localhost:${s.port}`}</span>
            </button>
          ))}
        </div>
      )}

      <div className={"browser-panel-viewport" + (dragging ? " is-dragging" : "") + (page ? " has-page" : "")}>
        {loading && <div className="browser-panel-loadbar" />}
        <iframe ref={frameRef} className="browser-panel-frame" src={hostUrl} title={t("browser.title")} />
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
    </div>
  );
}
