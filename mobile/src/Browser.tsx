import { useEffect, useRef, useState } from "react";
import "./browser.css";
import { useBackHandler, useEscape } from "./back";
import { useBrowserDrag, type Detent } from "./browserDrag";
import { pageLabel, pageSrc, parseTyped, sandboxFor, type Page } from "./browserUrl";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, CloseIcon, CopyIcon, FileIcon, GlobeIcon, MonitorIcon, RefreshIcon } from "./icons";
import { showToast } from "./remote";
import { useWide } from "./wide";

/** Hides the loading bar even if the page never reports `load`. */
const LOAD_TIMEOUT_MS = 20_000;
/** Duration of the close animation before the layer is removed. */
const CLOSE_MS = 220;

/** The small icon of a page's kind: desktop server, file, or none yet. */
function KindIcon({ page }: { page: Page | undefined }) {
  return page?.kind === "port" ? <MonitorIcon /> : page ? <FileIcon /> : <GlobeIcon />;
}

/**
 * In-app browser: the desktop's dev servers and the working folder's files, in an iframe.
 * On the phone it is a bottom drawer (half height, or full by dragging, the grabber or the
 * address field) over the chat; on a wide screen it covers the screen. Back/forward walk the
 * pages typed in the address field; navigation inside the page is not tracked (the iframe is
 * cross-origin to us), so Back leaves the page that was last typed, not the last link followed.
 * `chatId` or `ptyId` scopes relative files to that session's project folder; `suggested` lists
 * the pages linked in the chat, offered while the address is empty or being edited.
 */
export function Browser({ ptyId, chatId = null, initialPage = null, suggested = [], onClose }: { ptyId: string | null; chatId?: string | null; initialPage?: Page | null; suggested?: Page[]; onClose: () => void }) {
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
  const page: Page | undefined = pages[index];
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const closeTimer = useRef(0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    const instant = wide || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimer.current = window.setTimeout(onClose, instant ? 0 : CLOSE_MS);
  }

  useBackHandler(true, requestClose);
  useBackHandler(!wide && detent === "full", () => setDetent("half"));
  useEscape(true, () => (detent === "full" && !wide ? setDetent("half") : requestClose()));
  useBrowserDrag(dragRef, rootRef, !wide, (target) => (target === "closed" ? requestClose() : setDetent(target)));

  useEffect(() => {
    if (!initialPage || initialPage === previousPage.current) return;
    previousPage.current = initialPage;
    if (page && pageSrc(initialPage) === pageSrc(page)) return;
    setPages((previous) => [...previous.slice(0, index + 1), initialPage]);
    setIndex(index + 1);
    setEditing(false);
    setBad(false);
  }, [initialPage, index, page]);

  // A new load (page or reload) shows the bar until `onLoad` or the timeout.
  useEffect(() => {
    if (!page) return;
    setLoading(true);
    setFailed(false);
    const id = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [page, reload]);

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
    visit(next);
  }

  function copyAddress() {
    if (!page) return;
    void navigator.clipboard?.writeText(pageLabel(page));
    showToast(t("linkCopied"));
    inputRef.current?.blur();
  }

  const full = wide || editing || detent === "full";
  const showSuggestions = editing || !page;
  const rootClass = "br-root" + (wide ? " is-wide" : "") + (full ? " is-full" : "") + (!armed || closing ? " is-closed" : "");

  return (
    <div ref={rootRef} className={rootClass} role="dialog" aria-label={t("browser.title")}>
      <div ref={dragRef} className="br-drag">
        {!wide && <button type="button" className="br-grab" aria-label={t("browser.resize")} onClick={() => setDetent(detent === "full" ? "half" : "full")} />}
        <header className="br-head">
          <button type="button" className="br-btn" aria-label={t("browser.back")} disabled={index <= 0} onClick={() => setIndex(index - 1)}>
            <BackIcon />
          </button>
          {index < pages.length - 1 && (
            <button type="button" className="br-btn" aria-label={t("browser.forward")} onClick={() => setIndex(index + 1)}>
              <ChevronIcon />
            </button>
          )}
          <div className="br-addr-wrap">
            <span className="br-kind" aria-hidden="true">
              <KindIcon page={page} />
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
              value={editing ? draft : page ? pageLabel(page) : draft}
              onFocus={(e) => {
                setDraft(page ? pageLabel(page) : draft);
                setEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => {
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
        {page && <iframe ref={frameRef} key={`${index}:${reload}`} className="br-frame" title={pageLabel(page)} src={pageSrc(page)} sandbox={sandboxFor(page)} onLoad={() => setLoading(false)} />}
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
            {suggested.length > 0 && <h4>{t("browser.inChat")}</h4>}
            {suggested.map((item) => (
              <button key={pageLabel(item)} type="button" className="br-row" onPointerDown={(e) => e.preventDefault()} onClick={() => visit(item)}>
                <span className="br-kind-box" aria-hidden="true">
                  <KindIcon page={item} />
                </span>
                <span className="br-row-text">
                  <span className="br-row-name">{pageLabel(item)}</span>
                  <small>{item.kind === "port" ? t("browser.kindPort") : t("browser.kindFile")}</small>
                </span>
              </button>
            ))}
            {page && editing && (
              <button type="button" className="br-row" onPointerDown={(e) => e.preventDefault()} onClick={copyAddress}>
                <span className="br-kind-box" aria-hidden="true">
                  <CopyIcon />
                </span>
                <span className="br-row-text">
                  <span className="br-row-name is-action">{t("browser.copy")}</span>
                </span>
              </button>
            )}
            {!page && suggested.length === 0 && !bad && <div className="br-empty">{t("browser.empty")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
