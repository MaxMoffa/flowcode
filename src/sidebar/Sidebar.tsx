import { FileTree } from "./FileTree";
import "./sidebar.css";

interface SidebarProps {
  collapsed: boolean;
  cwd: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenTerminal: (path: string) => void;
}

export function Sidebar({ collapsed, cwd, onNavigate, onOpenFile, onOpenTerminal }: SidebarProps) {
  if (collapsed) return null;
  return (
    <aside className="sidebar">
      <FileTree cwd={cwd} onNavigate={onNavigate} onOpenFile={onOpenFile} onOpenTerminal={onOpenTerminal} />
    </aside>
  );
}
