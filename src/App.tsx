import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Sidebar } from "./sidebar/Sidebar";
import { isLikelyTextFile } from "./sidebar/fileIcons";
import { AgentsSidebar } from "./agents/AgentsSidebar";
import { TerminalView, type TerminalHandle } from "./terminal/Terminal";
import { TabStrip } from "./terminal/TabStrip";
import { EditorView, type EditorHandle } from "./editor/EditorView";
import { SymbolOutline } from "./editor/SymbolOutline";
import type { AppTab, TermTab, EditorTab } from "./tabs/types";
import { ThemeProvider, useTheme, type ThemeMode } from "./themes/ThemeContext";
import { TerminalSettingsProvider, useTerminalSettings } from "./terminal/TerminalSettingsContext";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider, useOpenContextMenu, type ContextMenuItem } from "./context-menu/ContextMenuContext";
import { ConfirmDialogProvider, useConfirmDialog } from "./dialog/ConfirmDialogContext";
import { SettingsPage } from "./settings/SettingsPage";
import { SettingsNav } from "./settings/SettingsNav";
import { SettingsSectionProvider } from "./settings/SettingsSectionContext";
import { PluginMenu } from "./plugins/PluginMenu";
import { PluginUsageButton } from "./plugins/PluginUsageButton";
import { PluginToast } from "./plugins/PluginToast";
import { PluginDialog } from "./plugins/PluginDialog";
import { BUILTIN_PLUGINS, EXAMPLE_PLUGINS, DEFAULT_QUICK_ACTIONS } from "./plugins/registry";
import { pluginIconNode } from "./plugins/icons";
import type { PluginDef, PluginManifest, PluginButtonDef } from "./plugins/types";
import { useResizablePanelWidth } from "./hooks/useResizablePanelWidth";
import "./App.css";

const appWindow = getCurrentWindow();

type SidebarMode = "auto" | "docked" | "floating";
const SIDEBAR_MODE_KEY = "flowcode.sidebarMode";
// Below this window width, "auto" mode floats the explorer instead of
// docking it, so a narrow window keeps its terminal usable.
const SIDEBAR_AUTO_BREAKPOINT = 880;

const QUICK_ACTIONS_KEY = "flowcode.quickActions";
const PLUGINS_SEEDED_KEY = "flowcode.pluginsSeeded";
const PLUGINS_MIGRATED_KEY = "flowcode.pluginsActionMigrated";

function readQuickActions(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(QUICK_ACTIONS_KEY) ?? "null");
    if (Array.isArray(stored) && stored.every((id) => typeof id === "string")) return stored;
  } catch {
    /* storage unavailable or malformed */
  }
  return DEFAULT_QUICK_ACTIONS;
}

const Icons = {
  kebab: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none">
      <circle cx="12" cy="5.5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="18.5" r="1.9" />
    </svg>
  ),
  zoomIn: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5" />
      <line x1="10.5" y1="7.5" x2="10.5" y2="13.5" />
      <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    </svg>
  ),
  zoomOut: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5" />
      <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    </svg>
  ),
  zoomReset: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
      <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" />
      <path d="M4 20v-4.5h4.5" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="4.2" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21.5" y2="12" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M21 12.6A9 9 0 1 1 11.4 3a7 7 0 0 0 9.6 9.6z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" />
    </svg>
  ),
  newTerminal: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <polyline points="7 9.5 10.5 12.5 7 15.5" />
      <line x1="12.5" y1="15.5" x2="16.5" y2="15.5" />
    </svg>
  ),
  clear: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M4 15.5 13.5 6a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L8.5 20H4z" />
      <line x1="12" y1="20" x2="20.5" y2="20" />
    </svg>
  ),
  sidebar: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    </svg>
  ),
  plugin: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M9 4.5h3v2.3a1.5 1.5 0 0 0 3 0V4.5h3v3h2.3a1.5 1.5 0 0 1 0 3H18v3h2.3a1.5 1.5 0 0 1 0 3H18v3h-3v-2.3a1.5 1.5 0 0 0-3 0V19.5H9v-3H6.7a1.5 1.5 0 0 1 0-3H9v-3H6.7a1.5 1.5 0 0 1 0-3H9z" />
    </svg>
  ),
  features: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  ),
};

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

/** POSIX ("/foo"), Windows drive-letter ("C:\foo" or "C:/foo") and UNC
 * ("\\host\share") absolute paths - what a real `cd`'s reported path looks
 * like on each platform this app runs on. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** A cwd is never a file - but a brand new cmd.exe console on Windows starts
 * out titled with the full path to its OWN executable (e.g.
 * `C:\Windows\System32\cmd.exe`), before anything has set a real title. That
 * happens to also pass `isAbsolutePath`, so without this check a fresh tab's
 * very first title update would stomp `explorerPath` with the shell binary's
 * own path instead of its actual working directory. */
function looksLikeExecutablePath(path: string): boolean {
  return /\.(exe|com|bat|cmd)$/i.test(path);
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
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(false);
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
  const sidebarResize = useResizablePanelWidth({
    storageKey: "flowcode.sidebarWidth",
    defaultWidth: 240,
    min: 180,
    max: 480,
    handleSide: "right",
  });
  const agentsResize = useResizablePanelWidth({
    storageKey: "flowcode.agentsSidebarWidth",
    defaultWidth: 240,
    min: 200,
    max: 480,
    handleSide: "left",
  });
  const [homeDir, setHomeDir] = useState<string>("");
  const [tabs, setTabs] = useState<AppTab[]>([
    { kind: "terminal", id: "tab-0", cwd: "", explorerPath: "", label: "shell" },
  ]);
  const [activeTabId, setActiveTabId] = useState("tab-0");
  const [activeTerminalId, setActiveTerminalId] = useState("tab-0");
  const [isMaximized, setIsMaximized] = useState(false);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [quickActionIds, setQuickActionIds] = useState<string[]>(readQuickActions);
  const [pluginMenuAnchor, setPluginMenuAnchor] = useState<DOMRect | null>(null);
  const [customPlugins, setCustomPlugins] = useState<PluginDef[]>([]);
  const [pluginToast, setPluginToast] = useState<string | null>(null);
  const [pluginDialog, setPluginDialog] = useState<PluginDef | null>(null);
  const pluginToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const termRefs = useRef(new Map<string, TerminalHandle>());
  // Command to type into a tab the instant its shell is ready - set by
  // openTerminalWithCommand, read once by that tab's own TerminalView via
  // its runOnStart prop (see the render loop below).
  const pendingCommandsRef = useRef(new Map<string, string>());
  const editorRefs = useRef(new Map<string, EditorHandle>());
  const pluginBtnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmDialog();
  const openMenu = useOpenContextMenu();
  const { mode, toggleTheme, setMode } = useTheme();
  const { fontSize, zoomIn, zoomOut, resetZoom } = useTerminalSettings();

  function toggleQuickAction(id: string) {
    setQuickActionIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(QUICK_ACTIONS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  function setSidebarMode(mode: SidebarMode) {
    setSidebarModeState(mode);
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }

  function pinToQuickActions(ids: string[]) {
    if (ids.length === 0) return;
    setQuickActionIds((prev) => {
      const next = [...prev, ...ids.filter((id) => !prev.includes(id))];
      try {
        localStorage.setItem(QUICK_ACTIONS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  /** Installs the example plugins (see registry.ts) once, ever - a flag in
   * localStorage (not "is the file missing") tracks that, so deleting one
   * later doesn't bring it back on the next launch. Also runs a one-time
   * migration for anyone who already had the first shipped shape of these
   * two (a "dialog" chooser popup) - superseded by launching directly on
   * click, with account status moved to the hover popover instead. */
  async function seedExamplePlugins() {
    try {
      const existing = await invoke<PluginManifest[]>("list_plugins");
      const byId = new Map(existing.map((p) => [p.id, p]));

      if (!localStorage.getItem(PLUGINS_MIGRATED_KEY)) {
        const migratedIds: string[] = [];
        for (const manifest of EXAMPLE_PLUGINS) {
          const current = byId.get(manifest.id);
          if (current && current.action !== manifest.action) {
            await invoke("save_plugin", { plugin: manifest });
            migratedIds.push(manifest.id);
          }
        }
        // Pin them to the shortcut bar too - the account-status ring/popover
        // this migration exists for is only visible there.
        pinToQuickActions(migratedIds);
      }

      if (!localStorage.getItem(PLUGINS_SEEDED_KEY)) {
        const newIds: string[] = [];
        for (const manifest of EXAMPLE_PLUGINS) {
          if (!byId.has(manifest.id)) {
            await invoke("save_plugin", { plugin: manifest });
            newIds.push(manifest.id);
          }
        }
        pinToQuickActions(newIds);
      }
    } catch {
      /* plugins folder unavailable (e.g. dev in a plain browser) */
    }
    try {
      localStorage.setItem(PLUGINS_MIGRATED_KEY, "1");
      localStorage.setItem(PLUGINS_SEEDED_KEY, "1");
    } catch {
      /* storage unavailable */
    }
  }

  async function reloadCustomPlugins() {
    try {
      const list = await invoke<PluginManifest[]>("list_plugins");
      setCustomPlugins(list.map((m) => ({ ...m, builtin: false })));
    } catch {
      /* plugins folder unavailable (e.g. dev in a plain browser) */
    }
  }

  async function addPlugin(manifest: PluginManifest) {
    try {
      await invoke("save_plugin", { plugin: manifest });
      await reloadCustomPlugins();
    } catch (e) {
      window.alert(`Impossibile salvare il plugin: ${e}`);
    }
  }

  async function deletePlugin(id: string) {
    try {
      await invoke("delete_plugin", { id });
      await reloadCustomPlugins();
      setQuickActionIds((prev) => prev.filter((x) => x !== id));
    } catch (e) {
      window.alert(`Impossibile eliminare il plugin: ${e}`);
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

  useEffect(() => {
    seedExamplePlugins().then(reloadCustomPlugins);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    },
    [],
  );

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
    toggleTheme: () => toggleTheme(),
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

  /** A fresh terminal tab whose one job is to run `command` - used for a
   * CLI's install/login step offered from the setup-check dialog, so the
   * user's actual working terminal is never hijacked for it. */
  function openTerminalWithCommand(command: string) {
    const id = `tab-${nextTabId++}`;
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, { kind: "terminal", id, cwd: homeDir, explorerPath: homeDir, label: "setup" }]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** Opens a fresh terminal tab in `cwd`, resuming a specific agent session
   * the moment its shell is ready - used from the Agents sidebar for a
   * background/saved session (one this app has no open tab for), so
   * double-clicking it drops the user straight back into that chat instead
   * of a bare shell they'd have to resume by hand. */
  function openAgentSession(cwd: string, sessionId: string, cli: "claude" | "codex") {
    const id = `tab-${nextTabId++}`;
    const command = cli === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
    pendingCommandsRef.current.set(id, command);
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

  function openSettings() {
    // Always shows the side nav, regardless of whether the panel was
    // collapsed - otherwise there's no hint that settings has more than
    // one page.
    setSidebarCollapsed(false);
    const existing = tabs.find((t) => t.kind === "settings");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs((prev) => [...prev, { kind: "settings", id: "settings", label: "Impostazioni" }]);
    setActiveTabId("settings");
  }

  async function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "terminal") {
      // The app always needs at least one terminal, but that's no reason to
      // refuse to close the last one outright - a stuck/broken session
      // (e.g. one whose shell never started right) then has no way to
      // recover short of restarting the whole app. Replace it in place with
      // a fresh tab instead: same effect for the user (a working terminal,
      // same slot), minus the dead end.
      if (tabs.filter((t) => t.kind === "terminal").length <= 1) {
        const cwd = tab.cwd || homeDir;
        const newId = `tab-${nextTabId++}`;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === id ? { kind: "terminal", id: newId, cwd, explorerPath: cwd, label: labelForCwd(cwd, homeDir) } : t,
          ),
        );
        setActiveTabId(newId);
        setActiveTerminalId(newId);
        termRefs.current.delete(id);
        return;
      }
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
        const cwd = isAbsolutePath(rawPath) && !looksLikeExecutablePath(rawPath) ? rawPath : t.cwd;
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

  const allPlugins: PluginDef[] = [...BUILTIN_PLUGINS, ...customPlugins];

  function showPluginToast(message: string) {
    setPluginToast(message);
    if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    pluginToastTimerRef.current = setTimeout(() => setPluginToast(null), 2600);
  }

  /** Before launching Claude Code / Codex, offers a one-click install (if
   * missing) or login (if installed but signed out) in a fresh terminal
   * instead of the shortcut just quietly doing nothing useful. `check_cli_status`
   * (src-tauri/src/plugins.rs) does the actual detection. */
  async function checkCliAndMaybeLaunch(cliBin: "claude" | "codex", launchCommand: string, term: TerminalHandle | undefined) {
    const label = cliBin === "claude" ? "Claude Code" : "Codex CLI";
    let status: { installed: boolean; logged_in: boolean };
    try {
      status = await invoke("check_cli_status", { cli: cliBin });
    } catch {
      // Detection itself failed - don't block the shortcut over it, just
      // fall back to the plain launch as before this check existed.
      term?.runCommandSilently(launchCommand);
      return;
    }

    if (!status.installed) {
      const isWindows = document.documentElement.dataset.platform === "windows";
      const installCommand =
        cliBin === "claude"
          ? isWindows
            ? "irm https://claude.ai/install.ps1 | iex"
            : "curl -fsSL https://claude.ai/install.sh | bash"
          : "npm install -g @openai/codex";
      const ok = await confirm({
        title: `${label} non è installato`,
        message: `${label} non risulta installato su questo sistema. Vuoi installarlo ora in un nuovo terminale?`,
        confirmLabel: "Installa",
      });
      if (ok) openTerminalWithCommand(installCommand);
      return;
    }

    if (!status.logged_in) {
      const loginCommand = cliBin === "claude" ? "claude auth login" : "codex login";
      const ok = await confirm({
        title: `Accesso a ${label} richiesto`,
        message: `${label} è installato ma non hai ancora effettuato l'accesso. Vuoi farlo ora in un nuovo terminale?`,
        confirmLabel: "Accedi",
      });
      if (ok) openTerminalWithCommand(loginCommand);
      return;
    }

    term?.runCommandSilently(launchCommand);
  }

  /** Runs the one thing a plugin (or a dialog-plugin's button) is allowed to
   * do - see PLUGINS.md at the repo root for why this stays a fixed, safe
   * vocabulary instead of arbitrary code. */
  function runPlugin(plugin: PluginDef | PluginButtonDef) {
    switch (plugin.action) {
      case "newTerminal":
        addTab();
        break;
      case "clearTerminal":
        termRefs.current.get(activeTerminalId)?.clear();
        break;
      case "toggleSidebar":
        setSidebarCollapsed((c) => !c);
        break;
      case "toggleAgentsSidebar":
        setAgentsSidebarOpen((o) => !o);
        break;
      case "runCommand": {
        if (!plugin.command) break;
        const term = termRefs.current.get(activeTerminalId);
        // Claude Code / Codex CLI take over the whole screen the moment
        // they start - unlike an arbitrary user-defined runCommand plugin,
        // there's no reason to leave the typed launch command sitting in
        // the scrollback above their UI. They're also the only plugins with
        // a known CLI binary behind them, which is what makes the
        // install/login pre-check possible - a plain runCommand plugin has
        // no such notion and always just runs.
        if ("id" in plugin && (plugin.id === "claude-code" || plugin.id === "codex-cli")) {
          const cliBin = plugin.id === "claude-code" ? "claude" : "codex";
          checkCliAndMaybeLaunch(cliBin, plugin.command, term);
        } else {
          term?.runCommand(plugin.command);
        }
        break;
      }
      case "notify":
        showPluginToast(plugin.message || plugin.label);
        break;
      case "dialog":
        // Only a top-level PluginDef can carry `action: "dialog"` - a
        // button's action type deliberately excludes it (dialogs don't nest).
        setPluginDialog(plugin as PluginDef);
        break;
      case "commandOutput":
        if (!plugin.command) break;
        invoke<string>("run_plugin_command", { command: plugin.command })
          .then((output) => setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: output }))
          .catch((err) =>
            setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: String(err) }),
          );
        break;
    }
  }

  function pluginMenuEntries() {
    return allPlugins.map((p) => ({
      id: p.id,
      label: p.label,
      icon: pluginIconNode(p),
      pinned: quickActionIds.includes(p.id),
      run: () => runPlugin(p),
      onTogglePin: () => toggleQuickAction(p.id),
    }));
  }

  // The side panel is contextual to whatever tab is active: the file
  // explorer for a terminal, a jump-to-function outline for a code file,
  // a section index for the settings page - falling back to the explorer
  // otherwise, since that's the most broadly useful default.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  let sidebarPanel: ReactNode;
  if (activeTab?.kind === "settings") {
    sidebarPanel = <SettingsNav />;
  } else if (activeTab?.kind === "editor") {
    const editorTab: EditorTab = activeTab;
    sidebarPanel = (
      <SymbolOutline
        label={editorTab.label}
        getContent={() => editorRefs.current.get(editorTab.id)?.getContent() ?? ""}
        onJump={(line) => editorRefs.current.get(editorTab.id)?.scrollToLine(line)}
      />
    );
  } else {
    sidebarPanel = (
      <Sidebar collapsed={false} cwd={sidebarCwd} onNavigate={browseExplorer} onOpenFile={openFile} onOpenTerminal={addTab} />
    );
  }

  const themeModeLabels: Record<ThemeMode, string> = {
    auto: "Automatico (sistema)",
    light: "Chiaro",
    dark: "Scuro",
  };

  function moreMenuItems(): ContextMenuItem[] {
    return [
      {
        label: "zoom-row",
        custom: (
          <div className="context-menu-zoom-row">
            <button type="button" className="context-menu-zoom-btn" aria-label="Riduci zoom" onClick={zoomOut}>
              −
            </button>
            <button type="button" className="context-menu-zoom-value" onClick={resetZoom} title="Reimposta zoom">
              {fontSize}px
            </button>
            <button type="button" className="context-menu-zoom-btn" aria-label="Aumenta zoom" onClick={zoomIn}>
              +
            </button>
          </div>
        ),
      },
      { separator: true, label: "sep-zoom" },
      ...(["auto", "light", "dark"] as ThemeMode[]).map((m) => ({
        label: themeModeLabels[m],
        icon: m === "auto" ? Icons.settings : m === "light" ? Icons.sun : Icons.moon,
        checked: mode === m,
        onSelect: () => setMode(m),
      })),
      { separator: true, label: "sep-theme" },
      { label: "Impostazioni…", icon: Icons.settings, onSelect: openSettings },
    ];
  }

  return (
    <div className={`app-shell${isMaximized ? " maximized" : ""}`}>
      <header className="app-headerbar" data-tauri-drag-region>
        <button
          className="icon-button"
          onClick={() => setSidebarCollapsed((c) => !c)}
          aria-label="Mostra/nascondi pannello laterale"
          title="Mostra/nascondi pannello laterale"
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
          {quickActionIds.length > 0 && (
            <div className="quick-actions">
              {quickActionIds.map((id) => {
                const plugin = allPlugins.find((p) => p.id === id);
                if (!plugin) return null;
                return <PluginUsageButton key={id} plugin={plugin} icon={pluginIconNode(plugin)} onRun={() => runPlugin(plugin)} />;
              })}
            </div>
          )}
          <button
            ref={pluginBtnRef}
            type="button"
            className="icon-button"
            onClick={() => setPluginMenuAnchor((r) => (r ? null : pluginBtnRef.current?.getBoundingClientRect() ?? null))}
            aria-label="Funzionalità"
            title="Funzionalità"
          >
            {Icons.features}
          </button>
          {pluginMenuAnchor && (
            <PluginMenu items={pluginMenuEntries()} anchorRect={pluginMenuAnchor} onClose={() => setPluginMenuAnchor(null)} />
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Altre opzioni"
            title="Altre opzioni"
            onClick={(e) => openMenu(e, moreMenuItems())}
          >
            {Icons.kebab}
          </button>
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
        {effectiveSidebarMode === "docked" && !sidebarCollapsed && (
          <div className="resizable-panel" style={{ width: sidebarResize.width }}>
            {sidebarPanel}
            <div
              className={"resize-handle resize-handle-right" + (sidebarResize.dragging ? " is-dragging" : "")}
              onPointerDown={sidebarResize.onHandlePointerDown}
            />
          </div>
        )}
        <div className="terminal-stack">
          {homeDir &&
            tabs.map((tab) => {
              if (tab.kind === "terminal") {
                return (
                  <TerminalView
                    key={tab.id}
                    ref={(handle) => {
                      if (handle) termRefs.current.set(tab.id, handle);
                      else termRefs.current.delete(tab.id);
                    }}
                    cwd={tab.cwd || undefined}
                    hidden={tab.id !== activeTabId}
                    onTitleChange={(title) => handleTitleChange(tab.id, title)}
                    runOnStart={pendingCommandsRef.current.get(tab.id)}
                  />
                );
              }
              if (tab.kind === "editor") {
                return (
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
                );
              }
              if (tab.id !== activeTabId) return null;
              return (
                <SettingsPage
                  key={tab.id}
                  quickActionIds={quickActionIds}
                  onToggleQuickAction={toggleQuickAction}
                  sidebarMode={sidebarMode}
                  onSetSidebarMode={setSidebarMode}
                  plugins={allPlugins}
                  onAddPlugin={addPlugin}
                  onDeletePlugin={deletePlugin}
                />
              );
            })}
        </div>
        {effectiveSidebarMode === "floating" && !sidebarCollapsed && (
          <div className="sidebar-floating-backdrop" onClick={() => setSidebarCollapsed(true)}>
            <div className="sidebar-floating-panel" onClick={(e) => e.stopPropagation()}>
              {sidebarPanel}
            </div>
          </div>
        )}
        {agentsSidebarOpen && (
          <div className="resizable-panel" style={{ width: agentsResize.width }}>
            <div
              className={"resize-handle resize-handle-left" + (agentsResize.dragging ? " is-dragging" : "")}
              onPointerDown={agentsResize.onHandlePointerDown}
            />
            <AgentsSidebar
              tabs={tabs.filter((t): t is TermTab => t.kind === "terminal")}
              activeTabId={activeTabId}
              getPtyId={(tabId) => termRefs.current.get(tabId)?.getPtyId() ?? null}
              onOpenTab={selectTab}
              onOpenSession={openAgentSession}
            />
          </div>
        )}
      </div>
      {pluginToast && <PluginToast message={pluginToast} />}
      {pluginDialog && (
        <PluginDialog plugin={pluginDialog} onRunButton={(button) => runPlugin(button)} onClose={() => setPluginDialog(null)} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <TerminalSettingsProvider>
        <SettingsSectionProvider>
          <ConfirmDialogProvider>
            <ContextMenuProvider>
              <Shell />
            </ContextMenuProvider>
          </ConfirmDialogProvider>
        </SettingsSectionProvider>
      </TerminalSettingsProvider>
    </ThemeProvider>
  );
}
