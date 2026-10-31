import { useEffect, useRef, useState } from "react";
import "./browser.css";
import { useBackHandler, useEscape } from "./back";
import { pageLabel, pageSrc, parseTyped, sandboxFor, type Page } from "./browserUrl";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, CloseIcon, RefreshIcon } from "./icons";

/** Hides the loading bar even if the page never reports `load`. */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * Full-screen in-app browser: the desktop's dev servers and the working folder's
 * files, in an iframe. Back/forward walk the pages typed in the address field;
 * navigation inside the page is not tracked (the iframe is cross-origin to us),
 * so Back leaves the page that was last typed, not the last link followed.
 * `ptyId` lets relative file names resolve against that terminal's folder.
 */
export function Browser({ ptyId, onClose }: { ptyId: string | null; onClose: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [index, setIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const page: Page | undefined = pages[index];

  useBackHandler(true, onClose);
  useEscape(true, onClose);

  // A new load (page or reload) shows the bar until `onLoad` or the timeout.
  useEffect(() => {
    if (!page) return;
    setLoading(true);
    const id = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [page, reload]);

  const inputRef = useRef<HTMLInputElement>(null);

  function go() {
    const next = parseTyped(draft, ptyId);
    if (!next) {
      setBad(true);
      return;
    }
    setBad(false);
    setEditing(false);
    inputRef.current?.blur();
    const kept = pages.slice(0, index + 1);
    setPages([...kept, next]);
    setIndex(kept.length);
    setReload((n) => n + 1);
  }

  return (
    <div className="br-root" role="dialog" aria-label={t("browser.title")}>
      <header className="br-head">
        <button type="button" className="br-btn" aria-label={t("closeViewer")} onClick={onClose}>
          <CloseIcon />
        </button>
        <button type="button" className="br-btn" aria-label={t("browser.back")} disabled={index <= 0} onClick={() => setIndex(index - 1)}>
          <BackIcon />
        </button>
        <button type="button" className="br-btn" aria-label={t("browser.forward")} disabled={index >= pages.length - 1} onClick={() => setIndex(index + 1)}>
          <ChevronIcon />
        </button>
        <button type="button" className="br-btn" aria-label={t("browser.reload")} disabled={!page} onClick={() => setReload((n) => n + 1)}>
          <RefreshIcon />
        </button>
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
      </header>
      <div className={"br-bar" + (loading ? " on" : "")} role="progressbar" aria-hidden={!loading} />
      {page ? (
        <iframe key={`${index}:${reload}`} className="br-frame" title={pageLabel(page)} src={pageSrc(page)} sandbox={sandboxFor(page)} onLoad={() => setLoading(false)} />
      ) : (
        <div className="br-empty">{t("browser.empty")}</div>
      )}
    </div>
  );
}
