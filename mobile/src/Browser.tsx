import { useEffect, useMemo, useRef, useState } from "react";
import "./browser.css";
import { useBackHandler, useEscape } from "./back";
import { chatLinkPages } from "./agentPreview";
import { useChatInfo, useChatSession } from "./chats";
import { useBrowserDrag, type Detent } from "./browserDrag";
import { BrowserTabs, shownLabel, TabPlaceholder } from "./BrowserTabs";
import { pageLabel, pageSrc, parseTyped, sandboxFor, type Page } from "./browserUrl";
import { openLink } from "./TermLink";
import type { BrowserTabPage } from "../../shared/remote-types";
import { reopenOp, useBrowserTabsSync, type Shown } from "./useBrowserTabsSync";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, CloseIcon, CopyIcon, FileIcon, GlobeIcon, MonitorIcon, RefreshIcon } from "./icons";
import { showToast } from "./remote";
import { useWide } from "./wide";

/** Hides the loading bar even if the page never reports `load`. */
const LOAD_TIMEOUT_MS = 20_000;
/** Duration of the close animation before the layer is removed. */
const CLOSE_MS = 220;
/** How long the "tabs closed" undo stays on screen. */
const UNDO_MS = 6000;

/** The small icon of a page's kind: desktop server, file, or none yet. */
function KindIcon({ page }: { page: Shown | undefined }) {
  return page?.kind === "port" ? <MonitorIcon /> : page && page.kind !== "external" ? <FileIcon /> : <GlobeIcon />;
}

/** The pages the chat linked, computed only while the suggestions are on screen; says the empty text itself when it has nothing and the browser has no page. */
function ChatPages({ chatId, filesChatId, hasPage, bad, onPick }: { chatId: string; filesChatId: string | null; hasPage: boolean; bad: boolean; onPick: (page: Page) => void }) {
  const items = useChatSession(chatId)?.model.items;
  const cwd = useChatInfo(chatId)?.cwd;
  const pages = useMemo(() => (items && cwd !== undefined ? chatLinkPages(items.flatMap((i) => (i.type === "agent" ? [i.text] : [])), filesChatId, cwd) : []), [items, filesChatId, cwd]);
  if (pages.length === 0) return !hasPage && !bad ? <div className="br-empty">{t("browser.empty")}</div> : null;
  return (
    <>
      <h4>{t("browser.inChat")}</h4>
      {pages.map((item) => (
        <button key={pageLabel(item)} type="button" className="br-row" onPointerDown={(e) => e.preventDefault()} onClick={() => onPick(item)}>
          <span className="br-kind-box" aria-hidden="true">
            <KindIcon page={item} />
          </span>
          <span className="br-row-text">
            <span className="br-row-name">{pageLabel(item)}</span>
            <small>{item.kind === "port" ? t("browser.kindPort") : t("browser.kindFile")}</small>
          </span>
        </button>
      ))}
    </>
  );
}

/**
 * In-app browser: the desktop's dev servers and the working folder's files, in an iframe.
 * On the phone it is a bottom drawer (half height, or full by dragging, the grabber or the
 * address field) over the chat; on a wide screen it covers the screen. Back/forward walk the
 * pages typed in the address field; navigation inside the page is not tracked (the iframe is
 * cross-origin to us), so Back leaves the page that was last typed, not the last link followed.
 * `chatId` or `ptyId` scopes relative files to that session's project folder; `linksChatId` names the
 * chat whose linked pages are offered while the address is empty or being edited.
 * `docked` (the tablet layout's docked panels) makes it a plain panel filling its parent card, like the
 * desktop's browser panel: no sheet, detents, drag-to-close or screen-wide back/Escape capture.
 */
export function Browser({ ptyId, chatId = null, initialPage = null, linksChatId = null, onClose, docked = false }: { ptyId: string | null; chatId?: string | null; initialPage?: Page | null; linksChatId?: string | null; onClose: () => void; docked?: boolean }) {
  const wide = useWide();
  const [pages, setPages] = useState<Page[]>(() => initialPage ? [initialPage] : []);
  const [index, setIndex] = useState(initialPage ? 0 : -1);
  const previousPage = useRef(initialPage);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [detent, setDetent] = useState<Detent>("half");
  const [armed, setArmed] = useState(false);
  const [closing, setClosing] = useState(false);
  const sync = useBrowserTabsSync();
  const synced = sync.synced;
  const [tabsOpen, setTabsOpen] = useState(false);
  const newPage = useRef(false);
  // What is on screen: the desktop's tab when the tabs are shared, else this browser's own history.
  const shown: Shown | undefined = synced ? sync.shown : pages[index];
  const page: Page | undefined = shown && shown.kind !== "external" && shown.kind !== "pdf" ? shown : undefined;
  const placeholder = shown?.kind === "external" || shown?.kind === "pdf" ? shown : undefined;
  const label = shown ? shownLabel(shown) : "";
  const src = page ? pageSrc(page) : "";
  const urlTab = synced && !sync.isLocal && sync.activeTab?.kind === "url" ? sync.activeTab : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const closeTimer = useRef(0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The tabs a group action just closed, offered back for a few seconds.
  const [undo, setUndo] = useState<BrowserTabPage[] | null>(null);
  const undoTimer = useRef(0);
  const clearUndo = () => {
    window.clearTimeout(undoTimer.current);
    setUndo(null);
  };
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);
  function closeMany(ids: string[]) {
    const closed = sync.closeMany(ids);
    if (closed.length === 0) return;
    if (closed.length >= sync.tabs.length) setTabsOpen(false);
    setUndo(closed);
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }

  function requestClose() {
    if (closing) return;
    setClosing(true);
    const instant = wide || docked || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimer.current = window.setTimeout(onClose, instant ? 0 : CLOSE_MS);
  }

  useBackHandler(!docked, requestClose);
  useBackHandler(tabsOpen, () => setTabsOpen(false));
  useBackHandler(!wide && !docked && detent === "full", () => setDetent("half"));
  useEscape(!docked || tabsOpen, () => (document.querySelector(".tm-layer.open") ? undefined : tabsOpen ? setTabsOpen(false) : detent === "full" && !wide ? setDetent("half") : requestClose()));
  useBrowserDrag(dragRef, rootRef, !wide && !docked, (target) => (target === "closed" ? requestClose() : setDetent(target)));

  // With shared tabs the page the opener asked for becomes a desktop tab (once per page).
  const syncedHandled = useRef<Page | null>(null);
  useEffect(() => {
    if (!synced || !initialPage || initialPage === syncedHandled.current) return;
    syncedHandled.current = initialPage;
    previousPage.current = initialPage;
    sync.visit(initialPage);
    setEditing(false);
    setBad(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, initialPage]);

  useEffect(() => {
    if (synced || !initialPage || initialPage === previousPage.current) return;
    previousPage.current = initialPage;
    if (page && pageSrc(initialPage) === pageSrc(page)) return;
    setPages((previous) => [...previous.slice(0, index + 1), initialPage]);
    setIndex(index + 1);
    setEditing(false);
    setBad(false);
  }, [synced, initialPage, index, page]);

  // A new load (page or reload) shows the bar until `onLoad` or the timeout.
  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const id = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [src, reload]);

  // The tunnel's error page tells us it could not reach the desktop.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frameRef.current?.contentWindow && (e.data as { flowcodeFrameError?: boolean } | null)?.flowcodeFrameError) setFailed(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);

  function visit(next: Page) {
    setBad(false);
    setEditing(false);
    inputRef.current?.blur();
    newPage.current = false;
    setTabsOpen(false);
    if (synced) {
      sync.visit(next);
      setReload((n) => n + 1);
      return;
    }
    const kept = pages.slice(0, index + 1);
    setPages([...kept, next]);
    setIndex(kept.length);
    setReload((n) => n + 1);
  }

  function go() {
    const next = parseTyped(draft, ptyId, chatId);
    if (!next) {
      setBad(true);
      return;
    }
    // An address typed over a url tab loads in that tab, unless "New page" was asked.
    if (synced && urlTab && next.kind === "port" && !newPage.current) {
      setBad(false);
      setEditing(false);
      inputRef.current?.blur();
      sync.navigate(urlTab.id, next);
      setReload((n) => n + 1);
      return;
    }
    visit(next);
  }

  function startNewPage() {
    setTabsOpen(false);
    newPage.current = true;
    setDraft("");
    setEditing(true);
    inputRef.current?.focus();
  }

  function copyAddress() {
    if (!shown) return;
    void navigator.clipboard?.writeText(label);
    showToast(t("linkCopied"));
    inputRef.current?.blur();
  }

  const full = wide || editing || detent === "full";
  const showSuggestions = editing || !shown;
  const rootClass = docked ? "br-root is-docked" : "br-root" + (wide ? " is-wide" : "") + (full ? " is-full" : "") + (!armed || closing ? " is-closed" : "");

  return (
    <div ref={rootRef} className={rootClass} role="dialog" aria-label={t("browser.title")}>
      <div ref={dragRef} className="br-drag">
        {!wide && !docked && <button type="button" className="br-grab" aria-label={t("browser.resize")} onClick={() => setDetent(detent === "full" ? "half" : "full")} />}
        <header className="br-head">
          <button type="button" className="br-btn" aria-label={t("browser.back")} disabled={synced ? !urlTab?.canBack : index <= 0} onClick={() => (synced ? urlTab && sync.step(urlTab.id, "back") : setIndex(index - 1))}>
            <BackIcon />
          </button>
          {(synced ? !!urlTab?.canForward : index < pages.length - 1) && (
            <button type="button" className="br-btn" aria-label={t("browser.forward")} onClick={() => (synced ? urlTab && sync.step(urlTab.id, "forward") : setIndex(index + 1))}>
              <ChevronIcon />
            </button>
          )}
          <div className="br-addr-wrap">
            <span className="br-kind" aria-hidden="true">
              <KindIcon page={shown} />
            </span>
            <input
              ref={inputRef}
              className={"br-addr" + (bad ? " bad" : "")}
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="localhost:5173"
              aria-label={t("browser.address")}
              aria-invalid={bad}
              value={editing ? draft : shown ? label : draft}
              onFocus={(e) => {
                setDraft(newPage.current ? "" : shown ? label : draft);
                setEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => {
                newPage.current = false;
                setEditing(false);
                setBad(false);
              }}
              onChange={(e) => {
                setDraft(e.target.value);
                setBad(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") go();
              }}
            />
          </div>
          {synced && (
            <button type="button" className="br-btn br-tabs-count" aria-label={t("browser.tabsCount", { n: sync.tabs.length })} aria-expanded={tabsOpen} onPointerDown={(e) => e.preventDefault()} onClick={() => setTabsOpen((v) => !v)}>
              <b>{sync.tabs.length}</b>
            </button>
          )}
          <button type="button" className="br-btn" aria-label={t("browser.reload")} disabled={!page} onClick={() => setReload((n) => n + 1)}>
            <RefreshIcon />
          </button>
          <button type="button" className="br-btn" aria-label={t("closeViewer")} onClick={requestClose}>
            <CloseIcon />
          </button>
        </header>
      </div>
      <div className={"br-bar" + (loading ? " on" : "")} role="progressbar" aria-hidden={!loading} />
      <div className="br-body">
        {page && <iframe ref={frameRef} key={`${synced ? "s" : index}:${reload}`} className="br-frame" title={label} src={src} sandbox={sandboxFor(page)} onLoad={() => setLoading(false)} />}
        {placeholder && <TabPlaceholder shown={placeholder} onOpenExternal={(url) => void openLink(url)} />}
        {page && failed && (
          <div className="br-fail">
            <h3>{page.kind === "port" ? t("browser.noServer", { port: page.port }) : t("browser.noFile")}</h3>
            <p>{page.kind === "port" ? t("browser.noServerHint") : t("browser.noFileHint", { path: pageLabel(page) })}</p>
            <button type="button" onClick={() => setReload((n) => n + 1)}>
              {t("browser.retry")}
            </button>
          </div>
        )}
        {showSuggestions && (
          <div className="br-sugg">
            {bad && <p className="br-bad">{t("browser.badAddress")}</p>}
            {linksChatId && <ChatPages chatId={linksChatId} filesChatId={chatId} hasPage={!!shown} bad={bad} onPick={visit} />}
            {shown && editing && (
              <button type="button" className="br-row" onPointerDown={(e) => e.preventDefault()} onClick={copyAddress}>
                <span className="br-kind-box" aria-hidden="true">
                  <CopyIcon />
                </span>
                <span className="br-row-text">
                  <span className="br-row-name is-action">{t("browser.copy")}</span>
                </span>
              </button>
            )}
            {!shown && !linksChatId && !bad && <div className="br-empty">{t("browser.empty")}</div>}
          </div>
        )}
        {synced && tabsOpen && (
          <BrowserTabs
            tabs={sync.tabs}
            servers={sync.servers}
            activeId={sync.isLocal ? null : sync.activeId}
            pcActiveId={sync.pcActiveId}
            onPick={(id) => {
              sync.select(id);
              setTabsOpen(false);
              setEditing(false);
              setBad(false);
              setReload((n) => n + 1);
            }}
            onClose={sync.close}
            onCloseMany={closeMany}
            onOpenServer={(port) => visit({ kind: "port", port, path: "/" })}
            onNew={startNewPage}
            onDismiss={() => setTabsOpen(false)}
          />
        )}
        {synced && undo && (
          <div className="br-undo" role="status">
            <span>{undo.length === 1 ? t("browser.closedOne") : t("browser.closedMany", { n: undo.length })}</span>
            {undo.some((p) => reopenOp(p, "") !== null) && (
              <button
                type="button"
                onClick={() => {
                  sync.reopen(undo);
                  clearUndo();
                }}
              >
                {t("browser.undo")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
