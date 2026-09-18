import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Sidebar } from "./sidebar/Sidebar";
import { isLikelyTextFile } from "./sidebar/fileIcons";
import { TerminalView, type TerminalHandle } from "./terminal/Terminal";
import { TabStrip } from "./terminal/TabStrip";
import { EditorView, type EditorHandle } from "./editor/EditorView";
import type { AppTab, TermTab } from "./tabs/types";
import { ThemeProvider } from "./themes/ThemeContext";
import { ThemeToggle } from "./themes/ThemeToggle";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider, useOpenContextMenu } from "./context-menu/ContextMenuContext";
import { ConfirmDialogProvider, useConfirmDialog } from "./dialog/ConfirmDialogContext";
import "./App.css";

const appWindow = getCurrentWindow();

type SidebarMode = "auto" | "docked" | "floating";
const SIDEBAR_MODE_KEY = "flowcode.sidebarMode";
// Below this window width, "auto" mode floats the explorer instead of
// docking it, so a narrow window keeps its terminal usable.
const SIDEBAR_AUTO_BREAKPOINT = 880;

function labelForCwd(cwd: string, home: string): string {
  if (cwd === home) return "~";
  const trimmed = cwd.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || "/";
}

/** Shells usually emit OSC titles as "user@host: /some/path" - keep just the
 * useful part, and collapse the home dir to `~` like a shell prompt would. */
function cleanTitle(raw: string, home: string): string {
  let title = raw.trim();
  const hostPrefix = title.match(/^[^\s@]+@[^\s:]+:\s*(.+)$/);
  if (hostPrefix) title = hostPrefix[1];
  if (home && title.startsWith(home)) title = "~" + title.slice(home.length);
  return title || "shell";
}

function expandHome(path: string, home: string): string {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

let nextTabId = 1;

function Shell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarMode, setSidebarModeState] = useState<SidebarMode>(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_MODE_KEY);
      if (stored === "docked" || stored === "floating" || stored === "auto") return stored;
      return "auto";
    } catch {
      return "auto";
    }
  });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [homeDir, setHomeDir] = useState<string>("");
  const [tabs, setTabs] = useState<AppTab[]>([
    { kind: "terminal", id: "tab-0", cwd: "", explorerPath: "", label: "shell" },
  ]);
  const [activeTabId, setActiveTabId] = useState("tab-0");
  const [activeTerminalId, setActiveTerminalId] = useState("tab-0");
  const [isMaximized, setIsMaximized] = useState(false);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const termRefs = useRef(new Map<string, TerminalHandle>());
  const editorRefs = useRef(new Map<string, EditorHandle>());
  const confirm = useConfirmDialog();
  const openMenu = useOpenContextMenu();

  function setSidebarMode(mode: SidebarMode) {
    setSidebarModeState(mode);
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }

  useEffect(() => {
    invoke<string>("home_dir").then((home) => {
      setHomeDir(home);
      setTabs((prev) =>
        prev.map((t) => (t.kind === "terminal" && t.cwd === "" ? { ...t, cwd: home, explorerPath: home, label: "~" } : t)),
      );
    });
  }, []);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const effectiveSidebarMode: "docked" | "floating" =
    sidebarMode === "auto" ? (windowWidth < SIDEBAR_AUTO_BREAKPOINT ? "floating" : "docked") : sidebarMode;

  useEffect(() => {
    if (effectiveSidebarMode !== "floating" || sidebarCollapsed) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarCollapsed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [effectiveSidebarMode, sidebarCollapsed]);

  useShortcuts({
    toggleSidebar: () => setSidebarCollapsed((c) => !c),
    clearTerminal: () => termRefs.current.get(activeTerminalId)?.clear(),
    newTab: () => addTab(),
    closeTab: () => closeTab(activeTabId),
  });

  function selectTab(id: string) {
    setActiveTabId(id);
    const tab = tabs.find((t) => t.id === id);
    if (tab?.kind === "terminal") setActiveTerminalId(id);
  }

  function addTab(cwdOverride?: string) {
    const active = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
    const cwd = cwdOverride || active?.cwd || homeDir;
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [...prev, { kind: "terminal", id, cwd, explorerPath: cwd, label: labelForCwd(cwd, homeDir) }]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  function openFile(path: string) {
    const name = path.split("/").pop() || path;
    if (!isLikelyTextFile(name)) {
      openPath(path).catch(() => {});
      return;
    }
    const existing = tabs.find((t) => t.kind === "editor" && t.path === path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `editor-${nextTabId++}`;
    setTabs((prev) => [...prev, { kind: "editor", id, path, label: name }]);
    setActiveTabId(id);
  }

  async function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "terminal") {
      if (tabs.filter((t) => t.kind === "terminal").length <= 1) return;
    } else {
      const handle = editorRefs.current.get(id);
      if (handle?.isDirty()) {
        const ok = await confirm({
          title: "Modifiche non salvate",
          message: `"${tab.label}" ha modifiche non salvate. Chiudere comunque?`,
          confirmLabel: "Chiudi senza salvare",
          danger: true,
        });
        if (!ok) return;
      }
    }
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (id === activeTabId) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (id === activeTerminalId) {
      const fallbackTerminal = next.find((t) => t.kind === "terminal");
      if (fallbackTerminal) setActiveTerminalId(fallbackTerminal.id);
    }
    setTabs(next);
    termRefs.current.delete(id);
    editorRefs.current.delete(id);
    setDirtyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function handleTitleChange(tabId: string, rawTitle: string) {
    const trimmed = rawTitle.trim();
    const hostPrefix = trimmed.match(/^[^\s@]+@[^\s:]+:\s*(.+)$/);
    const rawPath = expandHome(hostPrefix ? hostPrefix[1] : trimmed, homeDir);
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const cwd = rawPath.startsWith("/") ? rawPath : t.cwd;
        const label = t.customLabel ? t.label : cleanTitle(trimmed, homeDir);
        // A real cd in the shell is authoritative - follow it in the explorer too.
        return { ...t, cwd, explorerPath: cwd, label };
      }),
    );
  }

  function renameTab(id: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.kind === "terminal") return { ...t, label: trimmed, customLabel: true };
        return { ...t, label: trimmed };
      }),
    );
  }

  function handleEditorRenamed(id: string, newPath: string) {
    const label = newPath.split("/").pop() || newPath;
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, path: newPath, label } : t)));
  }

  function handleDirtyChange(id: string, dirty: boolean) {
    setDirtyIds((prev) => {
      const has = prev.has(id);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Sidebar navigation actually `cd`s the active shell (so it's really
   * there for the next command), but hides the injected command and its
   * echo completely - the terminal's on-screen content is untouched. `cwd`/
   * label catch up on their own next real prompt (OSC title update), same
   * as after a manually-typed `cd`. */
  function browseExplorer(path: string) {
    termRefs.current.get(activeTerminalId)?.navigateSilently(path);
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTerminalId && t.kind === "terminal" ? { ...t, explorerPath: path } : t)),
    );
  }

  const activeTerminal = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
  const sidebarCwd = activeTerminal?.explorerPath || homeDir;

  return (
    <div className={`app-shell${isMaximized ? " maximized" : ""}`}>
      <header className="app-headerbar" data-tauri-drag-region>
        <button
          className="icon-button"
          onClick={() => setSidebarCollapsed((c) => !c)}
          onContextMenu={(e) =>
            openMenu(e, [
              {
                label: "Automatica (in base alla larghezza)",
                checked: sidebarMode === "auto",
                onSelect: () => setSidebarMode("auto"),
              },
              { label: "Fissato nel layout", checked: sidebarMode === "docked", onSelect: () => setSidebarMode("docked") },
              {
                label: "Flottante (a comparsa)",
                checked: sidebarMode === "floating",
                onSelect: () => setSidebarMode("floating"),
              },
            ])
          }
          aria-label="Toggle file explorer"
          title="Toggle sidebar (click destro: modalità)"
        >
          <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
            <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
          </svg>
        </button>

        <TabStrip
          tabs={tabs}
          activeId={activeTabId}
          dirtyIds={dirtyIds}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={() => addTab()}
          onRename={renameTab}
        />

        <div className="header-right">
          <ThemeToggle />
          <div className="window-controls">
            <button className="icon-button" aria-label="Minimize" onClick={() => appWindow.minimize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6" y1="12" x2="18" y2="12" />
              </svg>
            </button>
            <button className="icon-button" aria-label="Maximize" onClick={() => appWindow.toggleMaximize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.6">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
              </svg>
            </button>
            <button className="icon-button icon-button-close" aria-label="Close" onClick={() => appWindow.close()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
                <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <div className="app-body">
        {effectiveSidebarMode === "docked" && (
          <Sidebar
            collapsed={sidebarCollapsed}
            cwd={sidebarCwd}
            onNavigate={browseExplorer}
            onOpenFile={openFile}
            onOpenTerminal={addTab}
          />
        )}
        <div className="terminal-stack">
          {homeDir &&
            tabs.map((tab) =>
              tab.kind === "terminal" ? (
                <TerminalView
                  key={tab.id}
                  ref={(handle) => {
                    if (handle) termRefs.current.set(tab.id, handle);
                    else termRefs.current.delete(tab.id);
                  }}
                  cwd={tab.cwd || undefined}
                  hidden={tab.id !== activeTabId}
                  onTitleChange={(title) => handleTitleChange(tab.id, title)}
                />
              ) : (
                <EditorView
                  key={tab.id}
                  ref={(handle) => {
                    if (handle) editorRefs.current.set(tab.id, handle);
                    else editorRefs.current.delete(tab.id);
                  }}
                  path={tab.path}
                  hidden={tab.id !== activeTabId}
                  onDirtyChange={(dirty) => handleDirtyChange(tab.id, dirty)}
                  onRenamed={(newPath) => handleEditorRenamed(tab.id, newPath)}
                />
              ),
            )}
        </div>
        {effectiveSidebarMode === "floating" && !sidebarCollapsed && (
          <div className="sidebar-floating-backdrop" onClick={() => setSidebarCollapsed(true)}>
            <div className="sidebar-floating-panel" onClick={(e) => e.stopPropagation()}>
              <Sidebar
                collapsed={false}
                cwd={sidebarCwd}
                onNavigate={browseExplorer}
                onOpenFile={openFile}
                onOpenTerminal={addTab}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ConfirmDialogProvider>
        <ContextMenuProvider>
          <Shell />
        </ContextMenuProvider>
      </ConfirmDialogProvider>
    </ThemeProvider>
  );
}
