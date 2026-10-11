import { useEffect, useState } from "react";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { onMessage, send, type LsEntry, type Tab } from "./remote";

function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function FilesScreen({ tabs, lastOpened }: { tabs: Tab[] | null; lastOpened: string | null }) {
  const list = tabs ?? [];
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<LsEntry[] | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);

  // Default to the terminal the user was last in; fall back if it vanished.
  const current = list.find((x) => x.ptyId === ptyId) ?? list.find((x) => x.ptyId === lastOpened) ?? list[0];
  const currentId = current?.ptyId;

  useEffect(() => {
    setPath("");
    setFile(null);
  }, [currentId]);

  useEffect(() => {
    if (!currentId) return;
    setEntries(null);
    send({ t: "ls", ptyId: currentId, path });
  }, [currentId, path]);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.t === "ls" && m.ptyId === currentId && m.path === path) setEntries(m.entries);
        else if (m.t === "file" && m.ptyId === currentId) setFile({ path: m.path, text: m.text, truncated: m.truncated });
        // A refused folder (outside the sandbox, gone...) would otherwise spin forever.
        else if (m.t === "error" && m.ptyId === currentId) setEntries((e) => e ?? []);
      }),
    [currentId, path],
  );

  if (!current) {
    return (
      <>
        <header className="top">
          <h1>{t("files")}</h1>
        </header>
        <div className="empty">{t("needTerminal")}</div>
      </>
    );
  }

  if (file) {
    return (
      <div className="viewer">
        <header className="viewer-head">
          <button type="button" className="icon-btn" aria-label={t("closeViewer")} onClick={() => setFile(null)}>
            <BackIcon />
          </button>
          <span className="term-title mono">{file.path.split("/").pop()}</span>
          {file.truncated && <span className="pill is-idle">{t("truncated")}</span>}
        </header>
        <pre className="code">{file.text}</pre>
      </div>
    );
  }

  const parts = path ? path.split("/") : [];
  return (
    <>
      <header className="top">
        <h1>{t("files")}</h1>
      </header>
      <label className="select">
        <span>{t("tab")}</span>
        <select value={current.ptyId} onChange={(e) => setPtyId(e.target.value)}>
          {list.map((x) => (
            <option key={x.ptyId} value={x.ptyId}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      <nav className="crumbs" aria-label="path">
        <button type="button" onClick={() => setPath("")} className={parts.length === 0 ? "on" : ""}>
          {t("root")}
        </button>
        {parts.map((p, i) => (
          <span key={i} className="crumb">
            <ChevronIcon />
            <button type="button" className={i === parts.length - 1 ? "on" : ""} onClick={() => setPath(parts.slice(0, i + 1).join("/"))}>
              {p}
            </button>
          </span>
        ))}
      </nav>
      {entries === null && <div className="empty">{t("loading")}</div>}
      {entries?.length === 0 && <div className="empty">{t("noEntries")}</div>}
      <div className="stack tight">
        {entries?.map((e) => (
          <button
            key={e.name}
            type="button"
            className="card row"
            onClick={() => (e.dir ? setPath(join(path, e.name)) : send({ t: "read", ptyId: current.ptyId, path: join(path, e.name) }))}
          >
            <span className="row-icon">{e.dir ? <FolderIcon /> : <FileIcon />}</span>
            <span className="row-body">
              <span className="row-title mono">{e.name}</span>
            </span>
            {!e.dir && <span className="row-sub">{formatSize(e.size)}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
