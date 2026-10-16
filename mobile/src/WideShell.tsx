import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import "./wide.css";
import { AgentsScreen } from "./Agents";
import { useBackHandler } from "./back";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { t } from "./i18n";
import { ActionIcon, AgentLogo, AgentsIcon, CloseIcon, FileIcon, FolderIcon, GridIcon, KebabIcon, PlusIcon, SlidersIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import { interrupt, send, useRemoteSelector, useSupports, type ConnStatus, type MirroredSettings, type Tab } from "./remote";
import { TermActions, runAction } from "./TermActions";
import { BusyArc, useOpenNewTab } from "./Terminals";
import { useSheetDrag } from "./useSheetDrag";
import { useDocked } from "./wide";
import { WideFileView } from "./WideFileView";
import { WideFiles } from "./WideFiles";
import { WideMenu } from "./WideMenu";

const TerminalScreen = lazy(() => import("./TerminalScreen").then((m) => ({ default: m.TerminalScreen })));
const SettingsScreen = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsScreen })));

/** A non-terminal tab: the settings page or a read-only file of a terminal's folder. */
type Doc = { id: "settings"; kind: "settings" } | { id: string; kind: "file"; ptyId: string; path: string };

interface Props {
  hostName?: string;
  tabs: Tab[] | null;
  settings: MirroredSettings | null;
  status: ConnStatus;
  activePty: string | null;
  onSelectPty: (ptyId: string) => void;
  onAddComputer: () => void;
}

/** The desktop-like layout of large screens: a header (panel toggles, tab strip, quick actions), then cards: files, one terminal, agents. */
export function WideShell({ hostName, tabs, settings, status, activePty, onSelectPty, onAddComputer }: Props) {
  const docked = useDocked();
  const [agentsOpen, setAgentsOpen] = useState(docked);
  const [filesOpen, setFilesOpen] = useState(docked);
  /** The open non-terminal tabs, in opening order. */
  const [docs, setDocs] = useState<Doc[]>([]);
  /** The id of the shown doc; null = the terminal is shown. */
  const [doc, setDoc] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [computersOpen, setComputersOpen] = useState(false);
  /** The key bar docked under the terminal. */
  const [keys, setKeys] = useState(true);
  const actions = useRemoteSelector((r) => r.actions);
  const canRename = useSupports("rename");
  /** The terminal tab being renamed, with its draft label. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const cancelRename = useRef(false);
  useEffect(() => setAgentsOpen(docked), [docked]);
  useEffect(() => setFilesOpen(docked), [docked]);

  const all = useMemo(() => tabs ?? [], [tabs]);
  const folders = useMemo(() => [...new Set(all.map((x) => x.cwd).filter(Boolean))], [all]);
  const select = (ptyId: string) => {
    setDoc(null);
    onSelectPty(ptyId);
  };
  const onCreate = useOpenNewTab(tabs, select);
  const closeDrawers = () => {
    setAgentsOpen(false);
    setFilesOpen(false);
  };
  useBackHandler(!docked && (agentsOpen || filesOpen), closeDrawers);
  // Floating panels (not docked) close by dragging them back toward their edge.
  const filesPanel = useRef<HTMLElement>(null);
  const agentsPanel = useRef<HTMLElement>(null);
  useSheetDrag(filesPanel, () => setFilesOpen(false), !docked && filesOpen, "left");
  useSheetDrag(agentsPanel, () => setAgentsOpen(false), !docked && agentsOpen, "right");
  useBackHandler(doc !== null, () => setDoc(null));

  // A closed terminal takes its files with it.
  useEffect(() => {
    if (tabs === null) return;
    const live = new Set(tabs.map((x) => x.ptyId));
    const keep = docs.filter((d) => d.kind !== "file" || live.has(d.ptyId));
    if (keep.length === docs.length) return;
    setDocs(keep);
    if (doc !== null && !keep.some((d) => d.id === doc)) setDoc(null);
  }, [tabs, docs, doc]);

  // A tab closed on the desktop ends its rename.
  useEffect(() => {
    if (renaming !== null && !all.some((x) => x.ptyId === renaming)) setRenaming(null);
  }, [all, renaming]);

  const startRename = (x: Tab) => {
    setDraft(x.label);
    setRenaming(x.ptyId);
  };
  /** Ends the title edit: Escape sets `cancelRename` before blurring, so it is dropped here. */
  const commitRename = (x: Tab) => {
    if (cancelRename.current) {
      cancelRename.current = false;
      setRenaming(null);
      return;
    }
    const label = draft.trim();
    setRenaming(null);
    if (label && label !== x.label) send({ t: "rename", ptyId: x.ptyId, label });
  };

  const openDoc = (d: Doc) => {
    setDocs((cur) => (cur.some((x) => x.id === d.id) ? cur : [...cur, d]));
    setDoc(d.id);
  };
  const openFile = (ptyId: string, path: string) => openDoc({ id: `file:${ptyId}:${path}`, kind: "file", ptyId, path });
  const closeDoc = (id: string) => {
    const i = docs.findIndex((d) => d.id === id);
    setDocs(docs.filter((d) => d.id !== id));
    if (doc === id) setDoc(i > 0 ? docs[i - 1].id : null);
  };
  const toggleAgents = () => {
    if (!docked && !agentsOpen) setFilesOpen(false);
    setAgentsOpen((v) => !v);
  };
  const toggleFiles = () => {
    if (!docked && !filesOpen) setAgentsOpen(false);
    setFilesOpen((v) => !v);
  };

  // A narrow strip scrolls: keep the shown tab in view (within the strip only).
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(".w-tab.on");
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
  }, [doc, activePty, docs.length]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeActions = useCallback(() => setActionsOpen(false), []);

  const active = activePty ? all.find((x) => x.ptyId === activePty) : undefined;
  const shown = doc !== null ? docs.find((d) => d.id === doc) : undefined;
  const activeFile = shown?.kind === "file" && shown.ptyId === activePty ? shown.path : null;
  const fileTab = shown?.kind === "file" ? all.find((x) => x.ptyId === shown.ptyId) : undefined;

  return (
    <div className={"screen wide" + (docked ? " docked" : "")}>
      <header className="w-top">
        <button type="button" className="w-ib" aria-label={t("showFiles")} aria-pressed={filesOpen} onClick={toggleFiles}>
          <FolderIcon />
        </button>
        <div className="w-tabs" role="tablist" ref={tabsRef}>
          {all.map((x) => {
            const on = doc === null && x.ptyId === activePty;
            const ico = (
              <span className="w-tab-ico">
                {(x.cli && <AgentLogo cli={x.cli} size={16} />) || <TerminalIcon />}
                {x.cli && x.status === "busy" && <BusyArc />}
              </span>
            );
            if (renaming === x.ptyId)
              return (
                <div key={x.ptyId} role="tab" aria-selected={on} className="w-tab on">
                  {ico}
                  <input
                    className="w-tab-input"
                    value={draft}
                    autoFocus
                    maxLength={128}
                    enterKeyHint="done"
                    aria-label={t("renameTerminal")}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      else if (e.key === "Escape") {
                        cancelRename.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={() => commitRename(x)}
                  />
                </div>
              );
            return (
              <button
                key={x.ptyId}
                type="button"
                role="tab"
                aria-selected={on}
                className={"w-tab" + (on ? " on" : "")}
                title={x.label}
                onClick={() => (on && canRename ? startRename(x) : select(x.ptyId))}
                onDoubleClick={() => canRename && startRename(x)}
              >
                {ico}
                <span className="w-tab-label">{x.label}</span>
                {x.cli && <i className={"dot " + (x.status === "waiting" ? "wait" : x.status === "busy" ? "busy" : "idle")} />}
              </button>
            );
          })}
          {docs.map((d) => {
            const on = doc === d.id;
            const label = d.kind === "settings" ? t("navSettings") : d.path.split("/").pop();
            return (
              <button key={d.id} type="button" role="tab" aria-selected={on} className={"w-tab" + (on ? " on" : "")} title={d.kind === "file" ? d.path : undefined} onClick={() => setDoc(d.id)}>
                <span className="w-tab-ico">{d.kind === "settings" ? <SlidersIcon /> : <FileIcon />}</span>
                <span className="w-tab-label">{label}</span>
                <span
                  role="button"
                  className="w-tab-x"
                  aria-label={t("closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeDoc(d.id);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          <button type="button" className="w-ib" aria-label={t("newTerminal")} onClick={() => setSheet(true)}>
            <PlusIcon />
          </button>
        </div>
        {active && actions.length > 0 && (
          <div className="w-group">
            {actions.map((a) => (
              <button key={a.id} type="button" className="w-ib" aria-label={t("runAction", { label: a.label })} title={a.label} onClick={() => runAction(active.ptyId, a)}>
                <ActionIcon action={a} />
              </button>
            ))}
          </div>
        )}
        <div className="w-group">
          <button type="button" className="w-ib" aria-label={t("features")} disabled={!active} onClick={() => setActionsOpen(true)}>
            <GridIcon />
          </button>
          <div className="w-anchor">
            <button type="button" className="w-ib" aria-label={t("moreOptions")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <KebabIcon />
            </button>
            <WideMenu
              open={menuOpen}
              keys={keys}
              noTerminal={!active}
              onClose={closeMenu}
              onNewTerminal={() => {
                setMenuOpen(false);
                setSheet(true);
              }}
              onKeys={() => {
                setMenuOpen(false);
                setKeys((v) => !v);
              }}
              onInterrupt={() => {
                setMenuOpen(false);
                if (active) interrupt(active.ptyId);
              }}
              onComputers={() => {
                setMenuOpen(false);
                setComputersOpen(true);
              }}
              onSettings={() => {
                setMenuOpen(false);
                openDoc({ id: "settings", kind: "settings" });
              }}
            />
          </div>
          <button type="button" className="w-ib" aria-label={t("showAgents")} aria-pressed={agentsOpen} onClick={toggleAgents}>
            <AgentsIcon />
          </button>
        </div>
        <ComputerSwitcher pill hostName={hostName} onAdd={onAddComputer} open={computersOpen} onOpenChange={setComputersOpen} />
      </header>
      <div className="w-body">
        {/* Kept mounted while closed, so the folder browsed survives closing the panel. */}
        <aside ref={filesPanel} className="w-side w-left" hidden={!filesOpen}>
          <WideFiles
            tab={active}
            activeFile={activeFile}
            onOpenFile={(p) => {
              if (!active) return;
              openFile(active.ptyId, p);
              if (!docked) setFilesOpen(false);
            }}
          />
        </aside>
        <main className="w-main">
          {shown?.kind === "settings" ? (
            <div className="page w-page">
              <Suspense fallback={null}>
                <SettingsScreen hostName={hostName} settings={settings} />
              </Suspense>
            </div>
          ) : shown?.kind === "file" ? (
            <WideFileView key={shown.id} ptyId={shown.ptyId} path={shown.path} cwd={fileTab?.cwd} />
          ) : active ? (
            <Suspense fallback={<div className="screen" />}>
              <TerminalScreen key={active.ptyId} tab={active} status={status} onBack={() => {}} embedded keys={keys} />
            </Suspense>
          ) : tabs !== null && tabs.length === 0 ? (
            <div className="empty">{t("noTabs")}</div>
          ) : null}
        </main>
        {agentsOpen && (
          <aside ref={agentsPanel} className="w-side w-right">
            <div className="w-ph">
              <span className="w-ph-title">{t("activeAgents")}</span>
              <button type="button" className="w-ib sm" aria-label={t("newTerminal")} onClick={() => setSheet(true)}>
                <PlusIcon />
              </button>
              <button type="button" className="w-ib sm" aria-label={t("closePanel")} onClick={() => setAgentsOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className="w-scroll">
              <AgentsScreen
                compact
                hostName={hostName}
                tabs={tabs}
                activePty={doc === null ? activePty : null}
                onOpen={(id) => {
                  select(id);
                  if (!docked) setAgentsOpen(false);
                }}
                onAddComputer={onAddComputer}
              />
            </div>
          </aside>
        )}
      </div>
      {!docked && (agentsOpen || filesOpen) && <div className="w-scrim" onClick={closeDrawers} />}
      {active && <TermActions tab={active} actions={actions} open={actionsOpen} onClose={closeActions} />}
      <NewTerminalSheet open={sheet} folders={folders} onClose={() => setSheet(false)} onCreate={onCreate} />
    </div>
  );
}
