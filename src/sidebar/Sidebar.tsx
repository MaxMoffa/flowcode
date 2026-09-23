import { FileTree } from "./FileTree";
import type { ExplorerLinkMode } from "../settings/modes";
import "./sidebar.css";

interface SidebarProps {
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
  cwd,
  onNavigate,
  onOpenFile,
  onOpenTerminal,
  linkMode,
  onSetLinkMode,
  terminalBusy,
}: SidebarProps) {
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
