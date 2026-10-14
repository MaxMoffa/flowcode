import { useState } from "react";
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
}

const SIDEBAR_TAB_KEY = "flowcode.sidebarTab";
const SIDEBAR_TABS = ["explorer", "git"] as const;
type SidebarTab = (typeof SIDEBAR_TABS)[number];
const readSidebarTab = (key: string) => readEnum<SidebarTab>(key, SIDEBAR_TABS, "explorer");

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
}: SidebarProps) {
  const { t } = useI18n();
  const [tab, setTab] = usePersistentState<SidebarTab>(SIDEBAR_TAB_KEY, readSidebarTab, writeString);
  const [changeCount, setChangeCount] = useState(0);

  return (
    <aside className="sidebar">
      <div className="sidebar-switch">
        <SegmentedSwitch
          options={[
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
      <div className="sidebar-panel" role="tabpanel" id="sidebar-panel-git" aria-labelledby="sidebar-tab-git" hidden={tab !== "git"}>
        <GitPanel cwd={cwd} visible={tab === "git"} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} onCountChange={setChangeCount} />
      </div>
    </aside>
  );
}
