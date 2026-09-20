import { FileTree } from "./FileTree";
import "./sidebar.css";

type ExplorerLinkMode = "auto" | "disconnesso";

interface SidebarProps {
  collapsed: boolean;
  cwd: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  linkMode: ExplorerLinkMode;
  onSetLinkMode: (mode: ExplorerLinkMode) => void;
  /** Whether the active terminal is currently busy with a full-screen
   * program - only meaningful to explain why "auto" is momentarily acting
   * disconnected, not something the sidebar otherwise reacts to. */
  terminalBusy: boolean;
}

export function Sidebar({
  collapsed,
  cwd,
  onNavigate,
  onOpenFile,
  onOpenTerminal,
  linkMode,
  onSetLinkMode,
  terminalBusy,
}: SidebarProps) {
  if (collapsed) return null;
  return (
    <aside className="sidebar">
      <FileTree
        cwd={cwd}
        onNavigate={onNavigate}
        onOpenFile={onOpenFile}
        onOpenTerminal={onOpenTerminal}
        linkMode={linkMode}
        onSetLinkMode={onSetLinkMode}
        terminalBusy={terminalBusy}
      />
    </aside>
  );
}
