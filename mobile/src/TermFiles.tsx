import { useEffect, useState } from "react";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { onMessage, send, type LsEntry, type Tab } from "./remote";
import { CloseIcon } from "./termIcons";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Quoted only when the shell would split or expand it. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The file explorer drawer of one terminal; paths are relative to the tab's cwd. */
export function TermFiles({ tab, open, onClose, onType }: { tab: Tab; open: boolean; onClose: () => void; onType: (text: string, run?: boolean) => void }) {
  const { ptyId, cwd } = tab;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<LsEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);

  // A `cd` (or any cwd change) moves the root under us.
  useEffect(() => {
    setPath("");
    setSelected(null);
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setSelected(null);
    send({ t: "ls", ptyId, path });
  }, [open, ptyId, path, cwd]);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.t === "ls" && m.ptyId === ptyId && m.path === path) setEntries([...m.entries].sort((a, b) => Number(b.dir) - Number(a.dir)));
        else if (m.t === "file" && m.ptyId === ptyId) setFile({ path: m.path, text: m.text, truncated: m.truncated });
        // A refused folder (outside the sandbox, gone...) would otherwise spin forever.
        else if (m.t === "error" && m.ptyId === ptyId) setEntries((e) => e ?? []);
      }),
    [ptyId, path],
  );

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
      <div className={"tm-layer" + (open ? " open" : "")}>
        <div className="tm-scrim" onClick={onClose} />
        <aside className="tm-drawer" role="dialog" aria-modal="true" aria-label={t("files")} aria-hidden={!open}>
          <header className="tm-sheet-head">
            <h2>{t("files")}</h2>
            <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <nav className="tm-crumbs" aria-label="path">
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
              const full = join(path, e.name);
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
                      <button type="button" className="tm-pill accent" onClick={() => onType(shellQuote(full) + " ")}>
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
              <button type="button" className="tm-pill accent" onClick={() => onType(`cd '${path.replace(/'/g, `'\\''`)}'`, true)}>
                {t("cdHere")}
              </button>
            )}
            <button type="button" className="tm-pill" onClick={() => onType((path ? shellQuote(path) : ".") + " ")}>
              {t("pasteFolder")}
            </button>
          </footer>
        </aside>
      </div>
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
