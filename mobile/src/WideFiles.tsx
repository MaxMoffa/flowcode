import { useEffect, useState } from "react";
import { formatSize, shortCwd } from "./common";
import { joinPath, useListing } from "./fileListing";
import { t } from "./i18n";
import { ChevronIcon, FileIcon, FolderIcon, HomeIcon, UpIcon } from "./icons";
import type { Tab } from "./remote";

/** The file explorer panel of the wide layout: browses the folder of `tab`, files open as tabs. */
export function WideFiles({ tab, activeFile, onOpenFile }: { tab: Tab | undefined; activeFile: string | null; onOpenFile: (path: string) => void }) {
  const [path, setPath] = useState("");
  const ptyId = tab?.ptyId;
  useEffect(() => setPath(""), [ptyId]);
  const entries = useListing({ ptyId: ptyId ?? "", cwd: tab?.cwd ?? "", path, setPath, enabled: !!tab });

  if (!tab) return <div className="empty">{t("noTabs")}</div>;

  const full = shortCwd(tab.cwd) + (path ? "/" + path : "");

  return (
    <>
      <header className="wf-head">
        <button type="button" aria-label={t("folderUp")} disabled={path === ""} onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
          <UpIcon />
        </button>
        <button type="button" aria-label={t("folderHome")} onClick={() => setPath("")}>
          <HomeIcon />
        </button>
        <span className="wf-path" title={full}>
          <bdi>{full}</bdi>
        </span>
      </header>
      <div className="wf-list">
        {entries === null && <div className="tm-empty">{t("loading")}</div>}
        {entries?.length === 0 && <div className="tm-empty">{t("noEntries")}</div>}
        {entries?.map((e) => {
          const p = joinPath(path, e.name);
          return (
            <button key={e.name} type="button" className={"wf-row" + (e.dir ? " dir" : "") + (!e.dir && p === activeFile ? " on" : "")} onClick={() => (e.dir ? setPath(p) : onOpenFile(p))}>
              <span className="wf-ico">{e.dir ? <FolderIcon /> : <FileIcon />}</span>
              <span className="wf-name">{e.name}</span>
              {e.dir ? <ChevronIcon /> : <span className="wf-size">{formatSize(e.size)}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
