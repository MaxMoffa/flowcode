import { useEffect, type RefObject } from "react";
import { t } from "../i18n";
import { createStore } from "../lib/externalStore";
import { formatBytes } from "../imageView/imageActions";
import { useRelativeTime } from "../newtab/useRelativeTime";
import { downloads, onDownload, type DownloadItem } from "./nativeView";

// The in-app browser's downloads (backend: src-tauri/src/browser_downloads.rs). The backend owns the
// list; this mirrors it through the `browser-download` event. The listener is registered once and
// never removed: a download can finish while the panel is closed.

const store = createStore<DownloadItem[]>([]);
let started = false;

const byNewest = (a: DownloadItem, b: DownloadItem) => b.startedAt - a.startedAt;

function upsert(item: DownloadItem) {
  store.update((list) => {
    const rest = list.filter((i) => i.id !== item.id);
    // `cancelled` / `removed`: the item left the list.
    if (item.state === "cancelled" || item.state === "removed") return rest;
    return [...rest, item].sort(byNewest);
  });
}

function start() {
  if (started) return;
  started = true;
  onDownload(upsert);
  void downloads
    .list()
    .then((list) => store.update((cur) => [...cur, ...list.filter((i) => !cur.some((c) => c.id === i.id))].sort(byNewest)))
    .catch(() => {});
}

export function useDownloads(): DownloadItem[] {
  useEffect(start, []);
  return store.use();
}

/** An item still being downloaded (even before the user answered). */
const isActive = (i: DownloadItem) => i.state === "downloading" || (i.state === "asking" && !i.finished);
export const hasActiveDownload = (items: DownloadItem[]) => items.some(isActive);

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

function kindOf(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(ext)) return "zip";
  if (/^(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(ext)) return "img";
  return "";
}

function FileBadge({ item }: { item: DownloadItem }) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(item.fileName)?.[1]?.toUpperCase() ?? "";
  return <span className={"browser-dl-ficon " + (item.dangerous ? "is-danger" : kindOf(item.fileName))}>{ext.slice(0, 4) || "FILE"}</span>;
}

/** The question under the header: the oldest unanswered download. It pushes the page down (no overlay),
 * so the native view stays live. */
export function DownloadsBar({ items }: { items: DownloadItem[] }) {
  const asking = items.filter((i) => i.state === "asking").sort((a, b) => a.startedAt - b.startedAt);
  const item = asking[0];
  if (!item) return null;
  const more = asking.length - 1;
  const meta = [item.size != null ? formatBytes(item.size) : null, item.host ? t("browser.downloads.from", { host: item.host }) : null].filter(Boolean).join(" · ");
  return (
    <div className={"browser-dl-ask" + (item.dangerous ? " is-danger" : "")} role="alertdialog" aria-label={t("browser.downloads.askTitle")}>
      <FileBadge item={item} />
      <div className="browser-dl-ask-text">
        <b title={item.fileName}>{item.fileName}</b>
        <small>{item.dangerous ? t("browser.downloads.dangerous") : meta}</small>
      </div>
      {more > 0 && <span className="browser-dl-more">{t("browser.downloads.more", { n: more })}</span>}
      <button type="button" className="browser-dl-btn is-ghost" onClick={() => quiet(downloads.answer(item.id, false))}>
        {t("browser.downloads.cancel")}
      </button>
      <button type="button" className={"browser-dl-btn " + (item.dangerous ? "is-warn" : "is-main")} onClick={() => quiet(downloads.answer(item.id, true))}>
        {item.dangerous ? t("browser.downloads.saveAnyway") : t("browser.downloads.save")}
      </button>
    </div>
  );
}

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
  </svg>
);
const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
  </svg>
);
const RetryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3" />
  </svg>
);
const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6l.5-9.5" />
  </svg>
);

/** Header button; rendered only while the list is not empty. A dot says something is downloading. */
export function DownloadsButton({ items, open, onToggle, buttonRef }: { items: DownloadItem[]; open: boolean; onToggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  if (items.length === 0) return null;
  return (
    <button ref={buttonRef} type="button" className={"browser-tabs-button browser-dl-button" + (open ? " is-open" : "")} onClick={onToggle} title={t("browser.downloads.title")} aria-label={t("browser.downloads.title")} aria-haspopup="true" aria-expanded={open}>
      <DownloadIcon />
      {hasActiveDownload(items) && <span className="browser-dl-badge" />}
    </button>
  );
}

function Row({ item, relative, close }: { item: DownloadItem; relative: (at: number) => string; close: () => void }) {
  const active = isActive(item);
  const openable = item.state === "done" && !item.dangerous;
  const sub =
    item.state === "failed" ? (
      <small className="is-err">{t("browser.downloads.failed")}</small>
    ) : active || item.state === "asking" ? (
      <small>{[t("browser.downloads.inProgress"), item.host].filter(Boolean).join(" · ")}</small>
    ) : (
      <small>{[item.size != null ? formatBytes(item.size) : null, relative(item.startedAt)].filter(Boolean).join(" · ")}</small>
    );
  return (
    <div className="browser-dl-row">
      <button
        type="button"
        className="browser-dl-row-main"
        disabled={!openable}
        title={item.dangerous && item.state === "done" ? t("browser.downloads.noOpen") : item.fileName}
        onClick={() => {
          quiet(downloads.open(item.id));
          close();
        }}
      >
        <FileBadge item={item} />
        <span className="browser-dl-row-text">
          <b>{item.fileName}</b>
          {active && (
            <span className="browser-dl-track">
              <i />
            </span>
          )}
          {sub}
        </span>
      </button>
      <span className="browser-dl-row-acts">
        {(active || item.state === "asking") && (
          <button type="button" title={t("browser.downloads.cancel")} aria-label={t("browser.downloads.cancel")} onClick={() => quiet(downloads.cancel(item.id))}>
            <XIcon />
          </button>
        )}
        {item.state === "done" && (
          <button type="button" title={t("browser.downloads.reveal")} aria-label={t("browser.downloads.reveal")} onClick={() => quiet(downloads.reveal(item.id))}>
            <FolderIcon />
          </button>
        )}
        {item.state === "failed" && (
          <button type="button" title={t("browser.downloads.retry")} aria-label={t("browser.downloads.retry")} onClick={() => quiet(downloads.retry(item.id))}>
            <RetryIcon />
          </button>
        )}
        {(item.state === "done" || item.state === "failed") && (
          <button type="button" title={t("browser.downloads.remove")} aria-label={t("browser.downloads.remove")} onClick={() => quiet(downloads.remove(item.id))}>
            <XIcon />
          </button>
        )}
      </span>
    </div>
  );
}

/** The list, in the tabs popover's style (`.browser-tabs-pop`). */
export function DownloadsPopover({ items, popRef, close }: { items: DownloadItem[]; popRef: RefObject<HTMLDivElement | null>; close: () => void }) {
  const relative = useRelativeTime();
  return (
    <div ref={popRef} className="browser-tabs-pop browser-dl-pop" role="dialog" aria-label={t("browser.downloads.title")}>
      <div className="browser-tabs-heading">{t("browser.downloads.title")}</div>
      {items.length === 0 && <div className="browser-menu-note">{t("browser.downloads.empty")}</div>}
      {items.map((item) => (
        <Row key={item.id} item={item} relative={relative} close={close} />
      ))}
      <div className="browser-tabs-sep" />
      <button type="button" role="menuitem" className="browser-menu-item" onClick={() => quiet(downloads.openFolder())}>
        <FolderIcon />
        {t("browser.downloads.openFolder")}
      </button>
      <button type="button" role="menuitem" className="browser-menu-item" disabled={!items.some((i) => i.state === "done" || i.state === "failed")} onClick={() => quiet(downloads.clear())}>
        <TrashIcon />
        {t("browser.downloads.clear")}
      </button>
    </div>
  );
}
