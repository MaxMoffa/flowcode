import { useLayoutEffect, useRef, useState } from "react";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { folderName, useExplorer } from "./explorerRemote";
import { t } from "./i18n";
import { BackIcon, ChevronIcon, CloseIcon, FolderIcon } from "./icons";
import { useSupports } from "./remote";
import "./explorer.css";

import { parentFromPath, pathCrumbs } from "./explorerPaths";

export function FolderPicker({ value, suggestions, onPick, onClose, allowDefault = false, title, confirmLabel }: {
  value?: string | null; suggestions: string[]; onPick: (path: string | null) => void; onClose: () => void;
  allowDefault?: boolean; title?: string; confirmLabel?: string;
}) {
  const [path, setPath] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const canBrowse = useSupports("fileExplorer");
  const crumbs = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth; }, [path]);
  const state = useExplorer(path ?? null, 0, canBrowse && path !== undefined);
  const response = state.response;
  const listing = path !== undefined && response?.kind === "list" ? response : undefined;
  const roots = response?.kind === "roots" ? response.roots : [];
  const suggested = [...new Set([value, ...suggestions].filter((p): p is string => !!p))].slice(0, 5);
  const enter = (p: string | null | undefined) => { setQuery(""); setPath(p); };
  const back = () => path === undefined ? onClose() : enter(path === null ? undefined : listing ? listing.parent : parentFromPath(path));
  useBackHandler(true, onClose);
  useEscape(true, onClose);
  const row = (label: string, p: string | null, sub?: string) => (
    <button type="button" className="fp-row" key={p ?? "computer"} onClick={() => enter(p)}>
      <FolderIcon /><span><b>{label}</b>{sub && <small className="mono">{sub}</small>}</span><ChevronIcon />
    </button>
  );
  return (
    <AdaptiveSheet open portal family="nts" variant="dialog" panelClass="fp-panel" onClose={onClose} label={title ?? t("filesChooseFolder")}>
      <header className="fx-header"><button type="button" className="fx-icon" aria-label={t("back")} onClick={back}><BackIcon /></button><h2>{title ?? t("filesChooseFolder")}</h2><button type="button" className="fx-icon" aria-label={t("profileCancel")} onClick={onClose}><CloseIcon /></button></header>
      {path !== undefined && <nav ref={crumbs} className="fx-crumbs" aria-label={t("path")}><button type="button" onClick={() => enter(undefined)}>{t("filesSuggested")}</button><button type="button" onClick={() => enter(null)}>{t("filesComputer")}</button>{path && pathCrumbs(path).map((c) => <button type="button" key={c.path} onClick={() => enter(c.path)}>{c.label}</button>)}</nav>}
      {listing && <input className="fp-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("filesFilterFolders")} aria-label={t("filesFilterFolders")} />}
      <div className="fp-body">
        {!canBrowse ? <p className="fx-notice">{t("filesUpgrade")}</p> : path === undefined ? <>
          <p className="fx-hint">{t("filesPickerHint")}</p>
          {suggested.length > 0 && <><h3>{t("filesSuggested")}</h3><div className="fp-list">{suggested.map((p) => row(folderName(p), p, p))}</div></>}
          <h3>{t("filesBrowse")}</h3><div className="fp-list">{row(t("filesComputer"), null, t("filesComputerHint"))}</div>
        </> : <>
          {state.error ? <p className="fx-notice" role="alert">{state.error}</p> : !response ? <p className="fx-hint" role="status">{t("loading")}</p> : listing ? <>
            <div className="fp-list">{listing.entries.filter((e) => e.dir && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((e) => row(e.name, `${listing.path.replace(/\/$/, "")}/${e.name}`))}</div>
            {!listing.entries.some((e) => e.dir && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="fx-hint">{query ? t("filesNoMatch") : t("filesNoFolders")}</p>}
            {listing.truncated && <p className="fx-notice">{t("filesListingTruncated")}</p>}
          </> : <div className="fp-list">{roots.map((r) => row(r.name, r.path, r.path))}</div>}
        </>}
      </div>
      <footer className="fp-footer"><small className="mono">{listing?.path ?? t("filesEnterFolder")}</small><button type="button" className="btn primary big" disabled={!canBrowse || !listing || !!state.error} onClick={() => listing && onPick(listing.path)}>{confirmLabel ?? t("filesUseFolder")}</button>{allowDefault && <button type="button" className="fp-default" onClick={() => onPick(null)}>{t("newTermStartFolder")}</button>}</footer>
    </AdaptiveSheet>
  );
}
