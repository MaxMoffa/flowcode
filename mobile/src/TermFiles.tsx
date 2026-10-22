import { useEffect, useMemo, useState } from "react";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, CloseIcon, FileIcon, FolderIcon } from "./icons";
import { formatSize } from "./common";
import { joinPath, useListing } from "./fileListing";
import { onMessage, send, showToast, type Tab } from "./remote";
import { cdCommand, dialectFor, shellQuote } from "./termShell";

/** The file explorer drawer of one terminal; paths are relative to the tab's cwd. */
export function TermFiles({ tab, open, onClose, onType }: { tab: Tab; open: boolean; onClose: () => void; onType: (text: string) => void }) {
  const { ptyId, cwd } = tab;
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const dialect = useMemo(() => dialectFor(cwd), [cwd]);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);

  const entries = useListing({ ptyId, cwd, path, setPath, enabled: open });
  useEffect(() => setSelected(null), [open, ptyId, path, cwd]);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.t === "file" && m.ptyId === ptyId) setFile({ path: m.path, text: m.text, truncated: m.truncated });
      }),
    [ptyId],
  );

  // Android Back closes the preview first, then the drawer.
  useBackHandler(open, onClose);
  useBackHandler(file !== null, () => setFile(null));

  /** Types the quoted path (never Enter: the user confirms). */
  const type = (text: string | null) => (text === null ? showToast(t("unsafeName")) : onType(text));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (file) setFile(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, file, onClose]);

  const parts = path ? path.split("/") : [];

  return (
    <>
      <AdaptiveSheet open={open} onClose={onClose} variant="drawer" side="left" phoneDrawer dragEnabled={file === null} label={t("files")}>
          <header className="tm-sheet-head">
            <h2>{t("files")}</h2>
            <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <nav className="tm-crumbs" aria-label={t("path")}>
            <button type="button" className={parts.length === 0 ? "on" : ""} onClick={() => setPath("")}>
              {t("root")}
            </button>
            {parts.map((p, i) => (
              <span key={i} className="tm-crumb">
                <ChevronIcon />
                <button type="button" className={i === parts.length - 1 ? "on" : ""} onClick={() => setPath(parts.slice(0, i + 1).join("/"))}>
                  {p}
                </button>
              </span>
            ))}
          </nav>
          <div className="tm-list">
            {entries === null && <div className="tm-empty">{t("loading")}</div>}
            {entries?.length === 0 && <div className="tm-empty">{t("noEntries")}</div>}
            {entries?.map((e) => {
              const full = joinPath(path, e.name);
              const on = selected === e.name;
              return (
                <div key={e.name} className={"tm-entry" + (on ? " on" : "")}>
                  <button type="button" className="tm-entry-main" onClick={() => (e.dir ? setPath(full) : setSelected(on ? null : e.name))}>
                    <span className={"tm-entry-icon" + (e.dir ? " dir" : "")}>{e.dir ? <FolderIcon /> : <FileIcon />}</span>
                    <span className="tm-entry-name">{e.name}</span>
                    {!e.dir && <span className="tm-entry-size">{formatSize(e.size)}</span>}
                  </button>
                  {on && !e.dir && (
                    <div className="tm-entry-actions">
                      <button type="button" className="tm-pill accent" onClick={() => { const q = shellQuote(full, dialect); type(q === null ? null : q + " "); }}>
                        {t("pastePath")}
                      </button>
                      <button type="button" className="tm-pill" onClick={() => send({ t: "read", ptyId, path: full })}>
                        {t("preview")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <footer className="tm-foot">
            {path && (
              <button type="button" className="tm-pill accent" onClick={() => type(cdCommand(path, dialect))}>
                {t("cdHere")}
              </button>
            )}
            <button type="button" className="tm-pill" onClick={() => { const q = path ? shellQuote(path, dialect) : "."; type(q === null ? null : q + " "); }}>
              {t("pasteFolder")}
            </button>
          </footer>
      </AdaptiveSheet>
      {file && (
        <div className="tm-viewer" role="dialog" aria-modal="true">
          <header className="tm-viewer-head">
            <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={() => setFile(null)}>
              <BackIcon />
            </button>
            <span className="tm-viewer-title">{file.path.split("/").pop()}</span>
            {file.truncated && <span className="tm-pill-tag">{t("truncated")}</span>}
          </header>
          <pre className="tm-code">{file.text}</pre>
        </div>
      )}
    </>
  );
}
