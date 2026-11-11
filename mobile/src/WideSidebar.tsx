import { useEffect, useState } from "react";
import "./wide-sidebar.css";
import { t } from "./i18n";
import { useSupports, type Tab } from "./remote";
import { safeStorage } from "./store";
import { WideFiles } from "./WideFiles";
import { WideGit } from "./WideGit";
import { WideHistory } from "./WideHistory";
import { WideTree } from "./WideTree";

type SideTab = "explorer" | "git" | "history";

const KEY = "wide.sideTab";
const savedTab = (): "explorer" | "git" => (safeStorage.get(KEY) === "git" ? "git" : "explorer");

export interface WideSidebarProps {
  /** Absolute folder of the shown terminal or chat. */
  cwd: string | null;
  /** The agent of the shown terminal or chat, when it is one. */
  agent: { cli: string; profile?: string | null; sessionId?: string | null } | null;
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

/** The left panel of the wide layout, as the desktop's sidebar: Explorer / Git / History (agents only). */
export function WideSidebar({ cwd, agent, activeFile, onOpenFile, onOpenDiff, onOpenTerminal, onOpenChat, onOpenPty, legacyTab, onOpenLegacyFile }: WideSidebarProps) {
  const canFs = useSupports("fileExplorer");
  const canGit = useSupports("git");
  const canHistory = useSupports("history");
  const hasHistory = !!agent && canHistory;
  /** The tab picked by hand; reset when the shown tab turns into (or out of) an agent. */
  const [picked, setPicked] = useState<SideTab | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => setPicked(null), [hasHistory]);
  useEffect(() => {
    if (!cwd) setCount(0);
  }, [cwd]);

  let tab: SideTab = picked ?? (hasHistory ? "history" : savedTab());
  if ((tab === "history" && !hasHistory) || (tab === "git" && !canGit)) tab = "explorer";
  const choose = (v: SideTab) => {
    setPicked(v);
    if (v !== "history") safeStorage.set(KEY, v);
  };

  if (!canFs) return legacyTab ? <WideFiles tab={legacyTab} activeFile={activeFile} onOpenFile={(p) => onOpenLegacyFile?.(p)} /> : <div className="empty">{t("filesUpgrade")}</div>;

  const tabs: { id: SideTab; label: string }[] = [
    { id: "explorer", label: t("wsExplorer") },
    ...(canGit ? [{ id: "git" as const, label: t("wsGit") }] : []),
    ...(hasHistory ? [{ id: "history" as const, label: t("wsHistory") }] : []),
  ];
  const none = <div className="empty">{t("wsNoCwd")}</div>;

  return (
    <>
      <div className="w-ph ws-tabs" role="tablist" aria-label={t("wsTabs")}>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={"ws-tab" + (tab === x.id ? " on" : "")} onClick={() => choose(x.id)}>
            {x.label}
            {x.id === "git" && count > 0 && <span className="ws-badge">{count > 99 ? "99+" : count}</span>}
          </button>
        ))}
      </div>
      {/* All panels stay mounted (hidden), so trees, drafts and polling state survive a tab switch. */}
      <div className="ws-panel" hidden={tab !== "explorer"}>
        {cwd ? <WideTree root={cwd} activeFile={activeFile} onOpenFile={onOpenFile} onOpenTerminal={onOpenTerminal} /> : none}
      </div>
      {canGit && (
        <div className="ws-panel" hidden={tab !== "git"}>
          {cwd ? <WideGit cwd={cwd} visible={tab === "git"} onOpenDiff={onOpenDiff} onCount={setCount} /> : none}
        </div>
      )}
      {hasHistory && cwd && agent && (
        <div className="ws-panel" hidden={tab !== "history"}>
          <WideHistory cwd={cwd} cli={agent.cli} profile={agent.profile} currentSessionId={agent.sessionId} visible={tab === "history"} onOpenChat={onOpenChat} onOpenPty={onOpenPty} />
        </div>
      )}
    </>
  );
}
