import { useState, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { GitPanel } from "../git/GitPanel";
import type { GitChange } from "../git/gitStatus";
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
}

const SIDEBAR_TAB_KEY = "flowcode.sidebarTab";
/** Kept apart from `SIDEBAR_TAB_KEY`, so a plain terminal keeps its own
 * Explorer/Git choice while agent tabs default to History. */
const AGENT_SIDEBAR_TAB_KEY = "flowcode.sidebarTab.agent";
const SIDEBAR_TABS = ["explorer", "git"] as const;
const AGENT_SIDEBAR_TABS = ["history", "explorer", "git"] as const;
type SidebarTab = (typeof AGENT_SIDEBAR_TABS)[number];
const readSidebarTab = (key: string) => readEnum<SidebarTab>(key, SIDEBAR_TABS, "explorer");
const readAgentSidebarTab = (key: string) => readEnum<SidebarTab>(key, AGENT_SIDEBAR_TABS, "history");

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
}: SidebarProps) {
  const { t } = useI18n();
  const [plainTab, setPlainTab] = usePersistentState<SidebarTab>(SIDEBAR_TAB_KEY, readSidebarTab, writeString);
  const [agentTab, setAgentTab] = usePersistentState<SidebarTab>(AGENT_SIDEBAR_TAB_KEY, readAgentSidebarTab, writeString);
  const tab = history ? agentTab : plainTab;
  const setTab = history ? setAgentTab : setPlainTab;
  const [changeCount, setChangeCount] = useState(0);

  return (
    <aside className="sidebar">
      <div className="sidebar-switch">
        <SegmentedSwitch
          options={[
            ...(history ? [{ id: "history" as const, label: t("sidebar.tab.history") }] : []),
            { id: "explorer", label: t("git.tab.explorer") },
            { id: "git", label: t("git.tab.git"), count: changeCount > 99 ? "99+" : changeCount },
          ]}
          value={tab}
          onChange={setTab}
          ariaLabel={t("git.tabs.aria")}
          idPrefix="sidebar"
        />
      </div>
      {/* Both panels stay mounted: the FileTree keeps its folder watcher (and
       * scroll/expansion state) while Git is showing, and Git keeps its draft
       * commit message. */}
      <div
        className="sidebar-panel"
        role="tabpanel"
        id="sidebar-panel-explorer"
        aria-labelledby="sidebar-tab-explorer"
        hidden={tab !== "explorer"}
      >
        <FileTree
          cwd={cwd}
          onNavigate={onNavigate}
          onGoHome={onGoHome}
          onOpenFile={onOpenFile}
          onOpenTerminal={onOpenTerminal}
          shell={shell}
          linkMode={linkMode}
          onSetLinkMode={onSetLinkMode}
          terminalBusy={terminalBusy}
          visible={tab === "explorer"}
        />
      </div>
      {history && (
        <div
          className="sidebar-panel"
          role="tabpanel"
          id="sidebar-panel-history"
          aria-labelledby="sidebar-tab-history"
          hidden={tab !== "history"}
        >
          {history(tab === "history")}
        </div>
      )}
      <div className="sidebar-panel" role="tabpanel" id="sidebar-panel-git" aria-labelledby="sidebar-tab-git" hidden={tab !== "git"}>
        <GitPanel cwd={cwd} visible={tab === "git"} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} onCountChange={setChangeCount} />
      </div>
    </aside>
  );
}
