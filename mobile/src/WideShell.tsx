import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import "./wide.css";
import { AgentsScreen } from "./Agents";
import { useBackHandler } from "./back";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { t } from "./i18n";
import { AgentLogo, AgentsIcon, FileIcon, FilesPanelIcon, PlusIcon, SlidersIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import type { ConnStatus, MirroredSettings, Tab } from "./remote";
import { BusyArc, useOpenNewTab } from "./Terminals";
import { useDocked } from "./wide";
import { WideFileView } from "./WideFileView";
import { WideFiles } from "./WideFiles";

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

/** The desktop-like layout of large screens: tab strip on top, one terminal, the agents panel on the right. */
export function WideShell({ hostName, tabs, settings, status, activePty, onSelectPty, onAddComputer }: Props) {
  const docked = useDocked();
  const [agentsOpen, setAgentsOpen] = useState(docked);
  const [filesOpen, setFilesOpen] = useState(docked);
  /** The open non-terminal tabs, in opening order. */
  const [docs, setDocs] = useState<Doc[]>([]);
  /** The id of the shown doc; null = the terminal is shown. */
  const [doc, setDoc] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
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

  // A narrow strip scrolls: keep the shown tab in view.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector(".w-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [doc, activePty, docs.length]);

  const active = activePty ? all.find((x) => x.ptyId === activePty) : undefined;
  const shown = doc !== null ? docs.find((d) => d.id === doc) : undefined;
  const activeFile = shown?.kind === "file" && shown.ptyId === activePty ? shown.path : null;

  return (
    <div className={"screen wide" + (docked ? " docked" : "")}>
      <header className="w-top">
        <ComputerSwitcher hostName={hostName} onAdd={onAddComputer} />
        <button type="button" className="w-icon-btn" aria-label={t("showFiles")} aria-pressed={filesOpen} onClick={toggleFiles}>
          <FilesPanelIcon />
        </button>
        <div className="w-tabs" role="tablist" ref={tabsRef}>
          {all.map((x) => {
            const on = doc === null && x.ptyId === activePty;
            return (
              <button key={x.ptyId} type="button" role="tab" aria-selected={on} className={"w-tab" + (on ? " on" : "")} onClick={() => select(x.ptyId)}>
                <span className="w-tab-ico">
                  {(x.cli && <AgentLogo cli={x.cli} size={16} />) || <TerminalIcon />}
                  {x.cli && x.status === "busy" && <BusyArc />}
                </span>
                <span>{x.label}</span>
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
                <span>{label}</span>
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
          <button type="button" className="w-icon-btn" aria-label={t("newTerminal")} onClick={() => setSheet(true)}>
            <PlusIcon />
          </button>
        </div>
        <button type="button" className="w-icon-btn" aria-label={t("showAgents")} aria-pressed={agentsOpen} onClick={toggleAgents}>
          <AgentsIcon />
        </button>
        <button
          type="button"
          className="w-icon-btn"
          aria-label={t("navSettings")}
          onClick={() => openDoc({ id: "settings", kind: "settings" })}
        >
          <SlidersIcon />
        </button>
      </header>
      <div className="w-body">
        {/* Kept mounted while closed, so the folder browsed survives closing the drawer. */}
        <aside className="w-side w-left" hidden={!filesOpen}>
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
            <WideFileView key={shown.id} ptyId={shown.ptyId} path={shown.path} />
          ) : active ? (
            <Suspense fallback={<div className="screen" />}>
              <TerminalScreen key={active.ptyId} tab={active} status={status} onBack={() => {}} embedded
                onFiles={() => {
                  setFilesOpen(true);
                  if (!docked) setAgentsOpen(false);
                }}
              />
            </Suspense>
          ) : tabs !== null && tabs.length === 0 ? (
            <div className="empty">{t("noTabs")}</div>
          ) : null}
        </main>
        {agentsOpen && (
          <aside className="w-side w-right">
            <div className="page w-page">
              <AgentsScreen
                compact
                hostName={hostName}
                tabs={tabs}
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
      <NewTerminalSheet open={sheet} folders={folders} onClose={() => setSheet(false)} onCreate={onCreate} />
    </div>
  );
}
