import { useMemo, useState, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { GitDock } from "./GitDock";
import { buildGitDecor } from "../git/gitDecor";
import type { GitChange, GitStatus } from "../git/gitStatus";
import type { ExplorerLinkMode } from "../settings/modes";
import { readEnum, usePersistentState, writeString } from "../lib/storage";
import { SegmentedSwitch } from "../lib/SegmentedSwitch";
import { useI18n } from "../i18n";
import "./sidebar.css";

interface SidebarProps {
  cwd: string;
  onNavigate: (path: string) => void;
  onGoHome: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (root: string, change: GitChange, staged: boolean) => void;
  onOpenTerminal: (path: string) => void;
  /** Shell id of the active terminal - stored with a folder added to the
   * favorites from here (see `FavoriteFolder.shell`). */
  shell?: string;
  linkMode: ExplorerLinkMode;
  onSetLinkMode: (mode: ExplorerLinkMode) => void;
  /** Whether the active terminal is currently busy with a full-screen
   * program - only meaningful to explain why "auto" is momentarily acting
   * disconnected, not something the sidebar otherwise reacts to. */
  terminalBusy: boolean;
  /** The agent history panel, given while the active tab runs a coding agent:
   * it adds a "History" tab (selected by default) and is told whether it is
   * the one showing. */
  history?: (visible: boolean) => ReactNode;
  /** Selected tab (see `useSidebarTab`); one that has no option falls back to the Explorer. */
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** The agent panel, given while the active tab runs an agent. */
  agent?: ReactNode;
}

/** Only agent tabs have a choice of tabs; a plain terminal just shows the
 * Explorer. An old stored "git" falls back to the default. */
const AGENT_SIDEBAR_TAB_KEY = "flowcode.sidebarTab.agent";
const AGENT_SIDEBAR_TABS = ["history", "explorer", "agent"] as const;
export type SidebarTab = (typeof AGENT_SIDEBAR_TABS)[number];
const readAgentSidebarTab = (key: string) => readEnum<SidebarTab>(key, AGENT_SIDEBAR_TABS, "history");
const noopSetTab = () => {};

/** agentMode: the active tab runs an agent (history and/or agent panel available). Plain tabs only have the Explorer. */
export function useSidebarTab(agentMode: boolean): [SidebarTab, (tab: SidebarTab) => void] {
  const [agentTab, setAgentTab] = usePersistentState<SidebarTab>(AGENT_SIDEBAR_TAB_KEY, readAgentSidebarTab, writeString);
  return agentMode ? [agentTab, setAgentTab] : ["explorer", noopSetTab];
}

export function Sidebar({
  cwd,
  onNavigate,
  onGoHome,
  onOpenFile,
  onOpenDiff,
  onOpenTerminal,
  shell,
  linkMode,
  onSetLinkMode,
  terminalBusy,
  history,
  tab,
  onTabChange,
  agent,
}: SidebarProps) {
  const { t } = useI18n();
  const [git, setGit] = useState<{ root: string; status: GitStatus } | null>(null);
  const gitDecor = useMemo(() => (git ? buildGitDecor(git.root, git.status) : null), [git]);
  const summary = useMemo(() => {
    if (!git) return null;
    const { status } = git;
    const count = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;
    return { branch: status.branch, ahead: status.ahead, behind: status.behind, count };
  }, [git]);
  const changeCount = summary?.count ?? 0;

  const options = [
    ...(history ? [{ id: "history" as const, label: t("sidebar.tab.history") }] : []),
    { id: "explorer" as const, label: t("git.tab.explorer"), count: changeCount > 99 ? "99+" : changeCount },
    ...(agent ? [{ id: "agent" as const, label: t("sidebar.tab.agent") }] : []),
  ];
  const shown: SidebarTab = options.some((o) => o.id === tab) ? tab : "explorer";

  return (
    <aside className="sidebar">
      {options.length > 1 && (
        <div className="sidebar-switch">
          <SegmentedSwitch options={options} value={shown} onChange={onTabChange} ariaLabel={t("git.tabs.aria")} idPrefix="sidebar" />
        </div>
      )}
      {/* The Explorer and History panels stay mounted: the FileTree keeps its
       * folder watcher (and scroll/expansion state), and the Git drawer inside
       * the Explorer keeps its draft commit message and its tree decorations.
       * The agent panel mounts only while showing: it polls. */}
      <div
        className="sidebar-panel"
        role="tabpanel"
        id="sidebar-panel-explorer"
        aria-labelledby="sidebar-tab-explorer"
        hidden={shown !== "explorer"}
      >
        <div className="sidebar-explorer-tree">
          <FileTree
            cwd={cwd}
            onNavigate={onNavigate}
            onGoHome={onGoHome}
            onOpenFile={onOpenFile}
            onOpenTerminal={onOpenTerminal}
            favorites
            openInPreview
            shell={shell}
            linkMode={linkMode}
            onSetLinkMode={onSetLinkMode}
            terminalBusy={terminalBusy}
            visible={shown === "explorer"}
            gitDecor={gitDecor}
          />
        </div>
        <GitDock
          cwd={cwd}
          visible={shown === "explorer"}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onStatusChange={setGit}
          summary={summary}
        />
      </div>
      {history && (
        <div
          className="sidebar-panel"
          role="tabpanel"
          id="sidebar-panel-history"
          aria-labelledby="sidebar-tab-history"
          hidden={shown !== "history"}
        >
          {history(shown === "history")}
        </div>
      )}
      {agent && shown === "agent" && (
        <div className="sidebar-panel" role="tabpanel" id="sidebar-panel-agent" aria-labelledby="sidebar-tab-agent">
          {agent}
        </div>
      )}
    </aside>
  );
}
