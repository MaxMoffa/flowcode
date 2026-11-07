import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FsRequest, FsResponse } from "../../shared/remote-types";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { formatSize } from "./common";
import { folderName, fullPath, requestFs, useExplorer } from "./explorerRemote";
import { FolderPicker } from "./FolderPicker";
import { launchPath, pathCrumbs } from "./explorerPaths";
import { t } from "./i18n";
import { AgentLogo, BackIcon, CloseIcon, DotsIcon, FileIcon, FolderIcon, HomeIcon, KebabIcon, MonitorIcon, PlusIcon, RefreshIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import { sendChecked, showToast, useRemoteSelector, useSupports, type Tab } from "./remote";
import { isHidden, setShowHidden, useShowHidden } from "./hiddenFiles";
import { safeStorage } from "./store";
import { PendingRow, useOpenNew } from "./Terminals";
import "./explorer.css";

type Sheet = { kind: "item" | "rename" | "delete"; path: string; dir: boolean } | { kind: "new" | "file" | "folder" };
const pathKey = (host?: string) => "files.path." + (host ?? "");

export function FilesScreen({ hostName, tabs, onOpen }: { hostName?: string; tabs: Tab[] | null; onOpen: (ptyId: string) => void }) {
  const key = pathKey(hostName);
  // Nothing remembered: open the home folder (the desktop lists it first among the roots) instead of the drives.
  const initial = () => { const path = safeStorage.get(key) || null; return { key, path, home: !path }; };
  const [location, setLocation] = useState(initial);
  if (location.key !== key) setLocation(initial());
  const showHidden = useShowHidden();
  const [more, setMore] = useState(false);
  const canBrowse = useSupports("fileExplorer");
  const status = useRemoteSelector((r) => r.status);
  const chats = useRemoteSelector((r) => r.chats);
  const [revision, setRevision] = useState(0);
  const state = useExplorer(location.path, revision, canBrowse);
  const listing = state.response?.kind === "list" ? state.response : undefined;
  const roots = state.response?.kind === "roots" ? state.response.roots : [];
  const entries = listing ? listing.entries.filter((e) => showHidden || !isHidden(e)) : [];
  const hiddenCount = listing ? listing.entries.length - entries.length : 0;
  const crumbs = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth; }, [location.path]);
  const [launch, setLaunch] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [move, setMove] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const { pending, onCreate } = useOpenNew(tabs, onOpen);
  const folders = useMemo(() => [...new Set([...(tabs ?? []).map((x) => x.cwd), ...(chats ?? []).map((x) => x.cwd)].filter(Boolean))], [tabs, chats]);
  const navigate = (path: string | null) => { setLaunch(false); setMore(false); setLocation({ key, path, home: false }); safeStorage.set(key, path ?? ""); };
  const closeSheet = () => { if (!busy) setSheet(null); };
  useEffect(() => { if (location.home && location.path === null && roots[0]) navigate(roots[0].path); }, [location.home, location.path, roots[0]?.path]);
  useBackHandler(more, () => setMore(false));
  useEscape(more, () => setMore(false));
  useBackHandler(launch, () => setLaunch(false));
  useEscape(launch, () => setLaunch(false));
  useBackHandler(sheet !== null, closeSheet);
  useEscape(sheet !== null, closeSheet);
  // The server's canonical path makes links and Windows separators unambiguous.
  useEffect(() => { if (listing && listing.path !== location.path) navigate(listing.path); }, [listing?.path]);
  useEffect(() => { setLaunch(false); setMore(false); setAgent(null); setSheet(null); setMove(null); setFile(null); }, [hostName]);
  useEffect(() => { if (status !== "online") setLaunch(false); }, [status]);

  const openSheet = (next: Sheet) => { setLaunch(false); setName("path" in next ? folderName(next.path) : ""); setError(""); setSheet(next); };
  const mutate = async (request: FsRequest) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await requestFs(request);
      setSheet(null); setRevision((n) => n + 1); showToast(t("filesChanged"));
    } catch (e) { const message = e instanceof Error ? e.message : String(e); setError(message); showToast(message); }
    finally { setBusy(false); }
  };
  const terminal = async (path: string) => {
    setLaunch(false); setSheet(null);
    if (await sendChecked({ t: "newtab", cwd: launchPath(path) })) onCreate(false, `${t("terminals")} · ${folderName(path)}`);
    else showToast(t("filesOffline"));
  };
  const agentAt = (path: string) => { setLaunch(false); setSheet(null); setAgent(path); };
  const currentPath = listing?.path;
  const hasSessions = sheet && "path" in sheet && sheet.dir && folders.some((p) => { const cwd = p.replace(/\\/g, "/"); return cwd === sheet.path || cwd.startsWith(sheet.path + "/"); });
  const saveName = () => {
    if (!sheet || !name.trim()) return;
    if (sheet.kind === "rename" && "path" in sheet) void mutate({ op: "rename", path: sheet.path, name: name.trim() });
    else if (currentPath) void mutate({ op: "create", path: currentPath, name: name.trim(), dir: sheet.kind === "folder" });
  };
  const actionButton = (label: string, onClick: () => void, danger = false) => <button type="button" className={danger ? "danger" : ""} onClick={onClick}>{label}</button>;

  return <div className="fx-screen">
    <header className="fx-header"><div><h1>{t("files")}</h1><small>{hostName}{hiddenCount > 0 && ` · ${t("filesHiddenCount", { n: hiddenCount })}`}</small></div><button type="button" className="fx-icon" aria-label={t("filesRefresh")} onClick={() => setRevision((n) => n + 1)}><RefreshIcon /></button>{currentPath && <button type="button" className="fx-icon" aria-label={t("filesNewFile")} onClick={() => openSheet({ kind: "new" })}><PlusIcon /></button>}<button type="button" className="fx-icon" aria-label={t("filesMore")} aria-haspopup="true" aria-expanded={more} onClick={() => { setLaunch(false); setMore((v) => !v); }}><KebabIcon /></button>
      {more && <><div className="fx-menu-scrim" onClick={() => setMore(false)} /><div className="fx-menu" role="menu" aria-label={t("filesMore")}>
        <button type="button" role="menuitemcheckbox" aria-checked={showHidden} onClick={() => setShowHidden(!showHidden)}><span>{t("filesShowHidden")}</span><i className={"switch" + (showHidden ? " on" : "")} aria-hidden="true" /></button>
        <hr />
        <button type="button" role="menuitem" onClick={() => { setMore(false); setLocation({ key, path: null, home: true }); safeStorage.set(key, ""); }}><HomeIcon /><span>{t("filesHome")}</span></button>
        <button type="button" role="menuitem" onClick={() => navigate(null)}><MonitorIcon /><span>{t("filesComputer")}</span></button>
      </div></>}</header>
    <nav ref={crumbs} className="fx-crumbs" aria-label={t("path")}><button type="button" onClick={() => navigate(null)}>{t("filesComputer")}</button>{location.path && pathCrumbs(location.path).map((c) => <button type="button" className={c.path === currentPath ? "on" : ""} key={c.path} onClick={() => navigate(c.path)}>{c.label}</button>)}</nav>
    <div className="fx-body"><PendingRow pending={pending} />
      {!canBrowse ? <p className="fx-notice">{t("filesUpgrade")}</p> : state.error ? <p className="fx-notice" role="alert">{state.error}</p> : !state.response ? <p className="fx-hint" role="status">{t("loading")}</p> : listing ? <>
        {entries.length === 0 && <p className="fx-notice">{t("noEntries")}</p>}
        <div className="fx-list">{entries.map((entry) => { const path = fullPath(listing.path, entry.name); return <div className="fx-row" key={entry.name}><button type="button" className="fx-entry" onClick={() => entry.dir ? navigate(path) : setFile(path)}>{entry.dir ? <FolderIcon /> : <FileIcon />}<span><b>{entry.name}</b>{!entry.dir && <small>{formatSize(entry.size)}</small>}</span></button><button type="button" className="fx-icon" aria-label={t("filesActions", { name: entry.name })} onClick={() => openSheet({ kind: "item", path, dir: entry.dir })}><DotsIcon /></button></div>; })}</div>
        {listing.truncated && <p className="fx-notice">{t("filesListingTruncated")}</p>}
      </> : <div className="fx-list">{roots.map((root) => <button type="button" key={root.path} className="fp-row" onClick={() => navigate(root.path)}><FolderIcon /><span><b>{root.name}</b><small className="mono">{root.path}</small></span></button>)}</div>}
    </div>
    {currentPath && !file && !sheet && !agent && !move && <>
      {launch && <button type="button" className="fx-dismiss" aria-label={t("filesCloseLaunch")} onClick={() => setLaunch(false)} />}
      <div className="fx-floating">{launch && <div className="fx-launch-menu" role="group" aria-label={t("filesLaunch")}><small>{t("filesIn", { name: folderName(currentPath) })}</small><button type="button" className="accent" onClick={() => agentAt(currentPath)}><AgentLogo cli="claude" />{t("newTermAgent")}</button><button type="button" onClick={() => void terminal(currentPath)}><TerminalIcon />{t("terminals")}</button></div>}<button type="button" className="fx-launch-button" aria-expanded={launch} onClick={() => setLaunch((v) => !v)}>{launch ? <CloseIcon /> : <PlusIcon />}{t("filesLaunch")}</button></div>
    </>}
    {agent && <NewTerminalSheet open agentOnly initialCli="claude" initialCwd={agent} folders={folders} onClose={() => setAgent(null)} onCreate={onCreate} />}
    {sheet && <AdaptiveSheet open portal family="nts" variant="dialog" onClose={closeSheet} label={"path" in sheet ? folderName(sheet.path) : t("newTerminalShort")}>
      <div className="nts-grab" /><h2>{"path" in sheet ? folderName(sheet.path) : sheet.kind === "folder" ? t("filesNewFolder") : sheet.kind === "file" ? t("filesNewFile") : t("newTerminalShort")}</h2>
      <div className="nts-body">
        {error && <p className="fx-notice" role="alert">{error}</p>}
        {sheet.kind === "item" && "path" in sheet && <div className="chat-menu-group">
          {sheet.dir && <>{actionButton(t("filesAgent"), () => agentAt(sheet.path))}{actionButton(t("filesTerminal"), () => void terminal(sheet.path))}</>}
          {!sheet.dir && actionButton(t("open"), () => { setSheet(null); setFile(sheet.path); })}
          {actionButton(t("rename"), () => openSheet({ ...sheet, kind: "rename" }))}
          {actionButton(t("filesMove"), () => { setSheet(null); setMove(sheet.path); })}
          {actionButton(t("filesDelete"), () => openSheet({ ...sheet, kind: "delete" }), true)}
        </div>}
        {sheet.kind === "new" && <div className="chat-menu-group">{actionButton(t("filesNewFolder"), () => openSheet({ kind: "folder" }))}{actionButton(t("filesNewFile"), () => openSheet({ kind: "file" }))}</div>}
        {["rename", "file", "folder"].includes(sheet.kind) && <><label className="fx-field">{t("filesName")}<input autoFocus value={name} disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) saveName(); }} /></label>{hasSessions && <p className="fx-notice">{t("filesActiveWarning")}</p>}<button type="button" className="btn primary big" disabled={busy || !name.trim()} onClick={saveName}>{busy ? t("loading") : t("filesSave")}</button></>}
        {sheet.kind === "delete" && "path" in sheet && <><p>{t("filesDeleteConfirm", { name: folderName(sheet.path) })}</p>{hasSessions && <p className="fx-notice">{t("filesActiveWarning")}</p>}<button type="button" className="btn big fx-danger" disabled={busy} onClick={() => void mutate({ op: "delete", path: sheet.path })}>{busy ? t("loading") : t("filesDelete")}</button></>}
      </div><button type="button" className="fp-default" disabled={busy} onClick={closeSheet}>{t("profileCancel")}</button>
    </AdaptiveSheet>}
    {move && <FolderPicker value={currentPath} suggestions={folders} title={t("filesMove")} confirmLabel={t("filesMoveHere")} onClose={() => setMove(null)} onPick={(destination) => { if (!destination) return; const path = move; setMove(null); void mutate({ op: "move", path, destination }); }} />}
    {file && <ExplorerFile key={file} path={file} onClose={() => { setFile(null); setRevision((v) => v + 1); }} />}
  </div>;
}

function ExplorerFile({ path, onClose }: { path: string; onClose: () => void }) {
  const [body, setBody] = useState<Extract<FsResponse, { kind: "file" }> | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void requestFs({ op: "read", path }, controller.signal).then((response) => { if (response.kind === "file") { setBody(response); setDraft(response.text); } }, (e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [path, revision]);
  const close = () => { if (!busy && (!edit || draft === body?.text || window.confirm(t("filesUnsaved")))) onClose(); };
  useBackHandler(true, close); useEscape(true, close);
  const save = async () => {
    if (!body?.version || body.truncated || busy) return;
    setBusy(true); setError("");
    try { await requestFs({ op: "write", path: body.path, text: draft, version: body.version }); setEdit(false); setBody(null); setRevision((n) => n + 1); showToast(t("filesSaved")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return createPortal(<section className="fx-viewer" role="dialog" aria-modal="true" aria-label={folderName(path)}><header className="fx-header"><button type="button" className="fx-icon" disabled={busy} aria-label={t("back")} onClick={close}><BackIcon /></button><div><h2>{folderName(path)}</h2><small className="mono">{path}</small></div>{body?.version && !body.truncated && <button type="button" className="fp-default" disabled={busy} onClick={() => edit ? void save() : setEdit(true)}>{busy ? t("loading") : edit ? t("filesSave") : t("filesEdit")}</button>}</header>{error && <p className="fx-notice" role="alert">{error}</p>}{body?.truncated && <p className="fx-notice">{t("filesTruncatedReadOnly")}</p>}{!body && !error && <p className="fx-hint">{t("loading")}</p>}{body && (edit ? <textarea className="fx-editor mono" aria-label={t("filesEdit")} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} /> : <pre className="fx-code mono">{body.text}</pre>)}</section>, document.body);
}
