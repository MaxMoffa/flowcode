import { useState } from "react";
import type { BrowserTabPage } from "../../shared/remote-types";
import { deskPageToPage, localLinkPage, pageLabel } from "./browserUrl";
import { t } from "./i18n";
import { CloseIcon, DotsIcon, FileIcon, GlobeIcon, MonitorIcon, PlusIcon } from "./icons";
import type { Shown } from "./useBrowserTabsSync";

const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;
const bare = (url: string) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The name of a page as the address field and the tabs list show it. */
export function shownLabel(shown: Shown): string {
  if (shown.kind === "external") return bare(shown.url);
  if (shown.kind === "pdf") return /^https?:\/\//i.test(shown.src) ? bare(shown.src) : baseName(shown.src);
  return pageLabel(shown);
}

/** The second line of a tab row: the address or the path on the desktop. */
function tabDetail(p: BrowserTabPage): string {
  return p.kind === "url" ? p.url : p.kind === "file" ? p.path : p.src;
}

function badgeClass(p: BrowserTabPage): string {
  if (p.kind === "file") return "br-tabs-badge is-file";
  return deskPageToPage(p).kind === "port" ? "br-tabs-badge" : "br-tabs-badge is-ext";
}

/**
 * The desktop's browser tabs, as a popover at the top of the browser body: pick one (only this
 * phone changes), close one (the desktop closes it too), open a detected server, or start a new page.
 */
export function BrowserTabs({ tabs, servers, activeId, pcActiveId, onPick, onClose, onCloseMany, onOpenServer, onNew, onDismiss }: {
  tabs: BrowserTabPage[];
  servers: { url: string; port: number; alive: boolean }[];
  activeId: string | null;
  pcActiveId: string | null;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  /** The group actions of the ⋯ menu; the caller closes the tabs and offers the undo. */
  onCloseMany: (ids: string[]) => void;
  onOpenServer: (port: number) => void;
  onNew: () => void;
  onDismiss: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const activeAt = tabs.findIndex((p) => p.id === activeId);
  const groups: { key: Parameters<typeof t>[0]; ids: string[]; danger?: boolean }[] = [
    { key: "browser.closeOthers", ids: activeAt < 0 ? [] : tabs.filter((p) => p.id !== activeId).map((p) => p.id) },
    { key: "browser.closeRight", ids: activeAt < 0 ? [] : tabs.slice(activeAt + 1).map((p) => p.id) },
    { key: "browser.closeFiles", ids: tabs.filter((p) => p.kind !== "url").map((p) => p.id) },
    { key: "browser.closeAll", ids: tabs.map((p) => p.id), danger: true },
  ];
  const openPorts = new Set(tabs.flatMap((p) => { const d = deskPageToPage(p); return d.kind === "port" ? [d.port] : []; }));
  const free = servers.filter((s) => s.alive && !openPorts.has(s.port) && localLinkPage(s.url)?.kind === "port");
  return (
    <>
      <div className="br-tabs-scrim" onClick={onDismiss} />
      <div className="br-tabs" role="dialog" aria-label={t("browser.tabs")}>
        <div className="br-tabs-head">
          <h5>{t("browser.tabsShared")}</h5>
          {tabs.length > 0 && (
            <button type="button" className="br-tabs-more" aria-label={t("browser.tabsActions")} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <DotsIcon />
            </button>
          )}
        </div>
        {menu && tabs.length > 0 && (
          <>
            <div className="br-tabs-menu-scrim" onClick={() => setMenu(false)} />
            <div className="br-tabs-menu" role="menu" aria-label={t("browser.tabsActions")}>
              {groups.map((g, i) => (
                <div key={g.key} className="br-tabs-menu-item">
                  {i === groups.length - 1 && <div className="br-tabs-menu-sep" />}
                  <button
                    type="button"
                    role="menuitem"
                    className={g.danger ? "is-danger" : undefined}
                    disabled={g.ids.length === 0}
                    onClick={() => {
                      setMenu(false);
                      onCloseMany(g.ids);
                    }}
                  >
                    <span>{t(g.key)}</span>
                    <b>{g.ids.length}</b>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {tabs.map((p, i) => {
          const d = deskPageToPage(p);
          return (
            <div key={p.id} className={"br-tabs-row" + (p.id === activeId ? " is-active" : "")}>
              <button type="button" className="br-tabs-pick" aria-current={p.id === activeId} onClick={() => onPick(p.id)}>
                <span className={badgeClass(p)} aria-hidden="true">{String.fromCharCode(65 + (i % 26))}</span>
                <span className="br-tabs-text">
                  <b>{shownLabel(d)}</b>
                  <small>
                    {p.id === pcActiveId && <span className="br-tabs-pc">{t("browser.pc")}</span>}
                    <span>{tabDetail(p)}</span>
                  </small>
                </span>
              </button>
              <button type="button" className="br-tabs-x" aria-label={t("browser.closeTab")} onClick={() => onClose(p.id)}>
                <CloseIcon />
              </button>
            </div>
          );
        })}
        {free.length > 0 && <h5>{t("browser.servers")}</h5>}
        {free.map((s) => (
          <div key={s.port} className="br-tabs-srv">
            <span className="br-tabs-badge" aria-hidden="true">
              <MonitorIcon />
            </span>
            <span className="br-tabs-text">
              <b className="is-mono">localhost:{s.port}</b>
              <small>
                <span>{t("browser.serverFound")}</span>
              </small>
            </span>
            <button type="button" onClick={() => onOpenServer(s.port)}>
              {t("browser.open")}
            </button>
          </div>
        ))}
        <button type="button" className="br-tabs-new" onClick={onNew}>
          <PlusIcon />
          {t("browser.newPage")}
        </button>
      </div>
    </>
  );
}

/** The body of a tab that has no iframe: an external address or a PDF. */
export function TabPlaceholder({ shown, onOpenExternal }: { shown: Extract<Shown, { kind: "external" | "pdf" }>; onOpenExternal: (url: string) => void }) {
  return (
    <div className="br-ext">
      <span className="br-ext-icon" aria-hidden="true">{shown.kind === "pdf" ? <FileIcon /> : <GlobeIcon />}</span>
      <h3>{shownLabel(shown)}</h3>
      {shown.kind === "external" ? (
        <>
          <p>{t("browser.externalHint")}</p>
          <button type="button" onClick={() => onOpenExternal(shown.url)}>{t("browser.openOnPhone")}</button>
        </>
      ) : (
        <p>{t("browser.pdfHint")}</p>
      )}
    </div>
  );
}
