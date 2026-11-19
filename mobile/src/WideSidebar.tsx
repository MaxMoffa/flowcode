import { useEffect, useState } from "react";
import "./wide-sidebar.css";
import { AgentInsight } from "./AgentInsight";
import { t } from "./i18n";
import { useSupports, type Tab } from "./remote";
import { safeStorage } from "./store";
import { WideFiles } from "./WideFiles";
import { WideGitDock } from "./WideGitDock";
import { WideHistory } from "./WideHistory";
import { WideTree } from "./WideTree";

export type SideTab = "history" | "explorer" | "agent";

const KEY = "wide.sideTab.agent";

/** The tab picked for agent tabs (plain terminals only have the explorer); an old stored "git" falls back to the explorer. */
export function readSideTab(): SideTab {
  const v = safeStorage.get(KEY);
  return v === "explorer" || v === "agent" || v === "history" ? v : v === "git" ? "explorer" : "history";
}
export const writeSideTab = (v: SideTab) => safeStorage.set(KEY, v);

export interface WideSidebarProps {
  /** Absolute folder of the shown terminal or chat. */
  cwd: string | null;
  /** The agent of the shown terminal or chat, when it is one. */
  agent: { cli: string; profile?: string | null; sessionId?: string | null; view?: "chat" | "terminal" } | null;
  /** The tab chosen for agent tabs, owned by the shell (its top-bar button selects "agent"). */
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  /** Whether the sidebar itself is showing (the agent panel polls only then). */
  open: boolean;
  /** What the Agente tab inspects: the shown terminal or chat. */
  ptyId?: string;
  chatId?: string;
  activeFile: string | null;
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (root: string, path: string, staged: boolean, status: string) => void;
  onOpenTerminal: (absPath: string) => void;
  onOpenChat: (chatId: string) => void;
  onOpenPty: (ptyId: string) => void;
  /** Desktops without the file explorer: the shown terminal and a handler for its relative files (the old flat list). */
  legacyTab?: Tab;
  onOpenLegacyFile?: (path: string) => void;
}

/** The left panel of the wide layout, as the desktop's sidebar: a switch Cronologia / Esplora / Agente (agents only), the explorer with the Git drawer docked below the tree. */
export function WideSidebar({ cwd, agent, tab: picked, onTab, open, ptyId, chatId, activeFile, onOpenFile, onOpenDiff, onOpenTerminal, onOpenChat, onOpenPty, legacyTab, onOpenLegacyFile }: WideSidebarProps) {
  const canFs = useSupports("fileExplorer");
  const canHistory = useSupports("history");
  const hasHistory = !!agent && canHistory;
  const hasAgent = !!agent;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!cwd) setCount(0);
  }, [cwd]);

  let tab: SideTab = picked;
  if ((tab === "history" && !hasHistory) || (tab === "agent" && !hasAgent)) tab = "explorer";

  if (!canFs) return legacyTab ? <WideFiles tab={legacyTab} activeFile={activeFile} onOpenFile={(p) => onOpenLegacyFile?.(p)} /> : <div className="empty">{t("filesUpgrade")}</div>;

  const tabs: { id: SideTab; label: string }[] = [
    ...(hasHistory ? [{ id: "history" as const, label: t("wsHistory") }] : []),
    { id: "explorer", label: t("wsExplorer") },
    ...(hasAgent ? [{ id: "agent" as const, label: t("agentPanel") }] : []),
  ];
  const none = <div className="empty">{t("wsNoCwd")}</div>;

  return (
    <>
      {tabs.length > 1 && (
        <div className="ws-switch" role="tablist" aria-label={t("wsTabs")}>
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={"ws-switch-option" + (tab === x.id ? " is-selected" : "")} onClick={() => onTab(x.id)}>
              <span className="ws-switch-text">{x.label}</span>
              {x.id === "explorer" && count > 0 && <span className="ws-switch-count">{count > 99 ? "99+" : count}</span>}
            </button>
          ))}
        </div>
      )}
      {/* All panels stay mounted (hidden), so trees, drafts and polling state survive a tab switch; the agent panel polls, so it mounts only when shown. */}
      <div className="ws-panel" hidden={tab !== "explorer"}>
        {cwd ? (
          <>
            <div className="ws-explorer-tree">
              <WideTree root={cwd} activeFile={activeFile} onOpenFile={onOpenFile} onOpenTerminal={onOpenTerminal} />
            </div>
            <GitDockIfSupported cwd={cwd} visible={open && tab === "explorer"} onOpenDiff={onOpenDiff} onCount={setCount} />
          </>
        ) : (
          none
        )}
      </div>
      {hasHistory && cwd && agent && (
        <div className="ws-panel" hidden={tab !== "history"}>
          <WideHistory cwd={cwd} cli={agent.cli} profile={agent.profile} currentSessionId={agent.sessionId} view={agent.view} visible={open && tab === "history"} onOpenChat={onOpenChat} onOpenPty={onOpenPty} />
        </div>
      )}
      {tab === "agent" && (
        <div className="ws-panel">
          <div className="w-scroll w-scroll-insight ws-agent">
            <AgentInsight ptyId={ptyId} chatId={chatId} open={open} onOpenChat={onOpenChat} />
          </div>
        </div>
      )}
    </>
  );
}

/** The Git drawer, only on desktops that serve Git. */
function GitDockIfSupported(props: Parameters<typeof WideGitDock>[0]) {
  return useSupports("git") ? <WideGitDock {...props} /> : null;
}
