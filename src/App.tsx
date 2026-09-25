import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
// `currentMonitor` is a module-level export, NOT a `Window` method - there is
// no `appWindow.currentMonitor()` in @tauri-apps/api v2 (only `primaryMonitor`,
// `availableMonitors` and friends are module-level too). Calling it off the
// window object throws a TypeError.
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Sidebar } from "./sidebar/Sidebar";
import { isLikelyTextFile } from "./sidebar/fileIcons";
import { AgentsSidebar } from "./agents/AgentsSidebar";
import { TerminalView, type TerminalHandle, type TerminalTransfer } from "./terminal/Terminal";
import { TabStrip } from "./terminal/TabStrip";
import type { EditorHandle } from "./editor/EditorView";
import { SymbolOutline } from "./editor/SymbolOutline";
import type { AppTab, TermTab, EditorTab } from "./tabs/types";
import { ThemeProvider, useTheme, type ThemeMode } from "./themes/ThemeContext";
import { TerminalSettingsProvider, useTerminalSettings } from "./terminal/TerminalSettingsContext";
import { loadSession, saveWindowSession, type SavedTab, type SavedWindow } from "./session/session";
import { UpdateProvider } from "./update/UpdateContext";
import {
  defaultWslDistro,
  sameShell,
  toWindowsPath,
  toWslPath,
  wslDistroOfPath,
  wslDistroOfShell,
  wslHomeDir,
  wslShellId,
} from "./terminal/wslPath";
import { cliInstallCommand } from "./cli/cliInstallCommands";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider, useOpenContextMenu, useContextMenu, type ContextMenuItem } from "./context-menu/ContextMenuContext";
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
import { FavoritesButton, StarIcon, favoritesMenuItem } from "./favorites/FavoritesButton";
import type { FavoriteFolder } from "./favorites/favoritesStore";
import { hasSeenWelcome } from "./welcome/welcomeSeen";
import { useResizablePanelWidth } from "./hooks/useResizablePanelWidth";
import { SIDEBAR_MODES, EXPLORER_LINK_MODES, type SidebarMode, type ExplorerLinkMode } from "./settings/modes";
import { readBool, readEnum, readJson, readString, usePersistentState, writeBool, writeString } from "./lib/storage";
import { basename, expandHome, isAbsolutePath, isWindowsHostPath, isWindowsPlatform } from "./lib/path";
import { withCodexLaunchFlags } from "./plugins/codexLaunch";
import { atShellPrompt, cdCommand, ptyForeground, type Foreground } from "./terminal/shellDialect";
import "./App.css";

const appWindow = getCurrentWindow();
/** The window Flowcode starts with - the one that restores the saved session
 * and checks for updates. Every other window was opened from it (a tab
 * dragged out, or a restored extra window). */
const isMainWindow = appWindow.label === "main";

/** A tab on its way to another window: what the receiving window needs to
 * rebuild it - for a terminal its still-running session (see
 * `TerminalHandle.release`), for an editor any unsaved text. */
interface TabTransfer {
  tab: AppTab;
  terminal?: TerminalTransfer & { shell?: string; fontSize?: number };
  editor?: { content: string; dirty: boolean };
  /** Where it was dropped in the receiving window (CSS px), when it was
   * dropped onto one - picks its slot in that window's tab strip. */
  drop?: { x: number; y: number };
}

/** What a window opened by `window_open` (src-tauri/src/windows.rs) starts
 * with. */
type WindowInit = { kind: "adopt"; transfer: TabTransfer } | { kind: "restore"; window: SavedWindow };

/** Mirrors `CursorTarget` in src-tauri/src/windows.rs. */
interface CursorTarget {
  label: string | null;
  x: number;
  y: number;
}

// Taken once per page load, not per effect run: the backend hands it out
// only once, and a remounted effect (StrictMode in dev) must see it too.
let windowInitPromise: Promise<WindowInit | null> | null = null;
function takeWindowInit(): Promise<WindowInit | null> {
  windowInitPromise ??= invoke<WindowInit | null>("window_take_init").catch(() => null);
  return windowInitPromise;
}

/** Where in this window's tab strip a tab dropped at (x, y) goes - `undefined`
 * (the end) when it wasn't dropped over the strip. */
function tabStripDropIndex(drop: { x: number; y: number } | undefined): number | undefined {
  const strip = document.querySelector(".tab-strip")?.getBoundingClientRect();
  if (!drop || !strip || drop.y < strip.top - 30 || drop.y > strip.bottom + 30) return undefined;
  return Array.from(document.querySelectorAll(".tab-strip > .term-tab:not(.term-tab-folder)")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 < drop.x;
  }).length;
}

// Loaded on demand: CodeMirror (every language grammar) and the flowkit
// onboarding flow are the bulk of the bundle, and plenty of sessions never
// open a file - the welcome flow only ever shows on first launch.
const EditorView = lazy(() => import("./editor/EditorView").then((m) => ({ default: m.EditorView })));
const WelcomeFlow = lazy(() => import("./welcome/WelcomeFlow").then((m) => ({ default: m.WelcomeFlow })));

const SIDEBAR_MODE_KEY = "flowcode.sidebarMode";
const EXPLORER_LINK_MODE_KEY = "flowcode.explorerLinkMode";
// Below this window width, "auto" mode floats the explorer instead of
// docking it, so a narrow window keeps its terminal usable.
const SIDEBAR_AUTO_BREAKPOINT = 880;

const QUICK_ACTIONS_KEY = "flowcode.quickActions";
const PLUGINS_SEEDED_KEY = "flowcode.pluginsSeeded";
const PLUGINS_MIGRATED_KEY = "flowcode.pluginsActionMigrated";
const FAVORITES_BUTTON_VISIBLE_KEY = "flowcode.favoritesButtonVisible";
const SIDEBAR_COLLAPSED_KEY = "flowcode.sidebarCollapsed";
const AGENTS_SIDEBAR_OPEN_KEY = "flowcode.agentsSidebarOpen";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
const readQuickActions = (key: string) => readJson(key, isStringArray, DEFAULT_QUICK_ACTIONS);
const writeJson = (key: string, value: unknown) => writeString(key, JSON.stringify(value));
const readTrue = (key: string) => readBool(key, true);
const readFalse = (key: string) => readBool(key, false);
const readSidebarMode = (key: string) => readEnum(key, SIDEBAR_MODES, "auto");
const readLinkMode = (key: string) => readEnum(key, EXPLORER_LINK_MODES, "auto");

const Icons = {
  kebab: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none">
      <circle cx="12" cy="5.5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="18.5" r="1.9" />
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
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  themeAuto: (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M9 4.5H5.5a1 1 0 0 0-1 1V9M15 4.5h3.5a1 1 0 0 1 1 1V9M20 15v3.5a1 1 0 0 1-1 1H15M4.5 15v3.5a1 1 0 0 0 1 1H9" />
    </svg>
  ),
  fullscreenExit: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <path d="M9 9H5.5M9 9V5.5M9 9 4.5 4.5M15 9h3.5M15 9V5.5M15 9l4.5-4.5M15 15h3.5M15 15v3.5M15 15l4.5 4.5M9 15H5.5M9 15v3.5M9 15 4.5 19.5" />
    </svg>
  ),
  newTerminal: (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" stroke="currentColor">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <polyline points="7 9.5 10.5 12.5 7 15.5" />
      <line x1="12.5" y1="15.5" x2="16.5" y2="15.5" />
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

/** The context menu's zoom row, as its own component rather than inline JSX
 * built from App's own state - the menu's items are a snapshot captured
 * once when it opens (see ContextMenuProvider), so a plain `{size}px` baked
 * into that snapshot would never update after +/- clicks while the menu
 * stays open. Subscribing to `useTerminalSettings()` here instead means this
 * component re-renders off the context itself, independent of when its
 * enclosing JSX was created.
 *
 * +/- here zoom only `tabId` (the last-active terminal), like a browser's
 * per-tab zoom - the app-wide default (Settings > terminale) is untouched.
 * When this tab's size has drifted from that default, the value switches to
 * the accent color and a reset button appears next to it. The px box itself
 * is a real input - typing a value and committing it (Enter/blur) goes
 * through the same `setTabFontSize` the +/- buttons use. */
function ZoomRow({ tabId }: { tabId: string }) {
  const {
    fontSize: defaultSize,
    tabFontSizeOverrides,
    getTabFontSize,
    zoomTabIn,
    zoomTabOut,
    setTabFontSize,
    resetTabZoom,
  } = useTerminalSettings();
  const size = getTabFontSize(tabId);
  const isCustom = tabId in tabFontSizeOverrides;
  // A locally-staged copy of the digits being typed - committing on every
  // keystroke would run each partial value through `setTabFontSize`'s
  // clamp (e.g. "1" while typing "12" would clamp up to MIN_SIZE and never
  // let the second digit land). Only applied on blur/Enter; reverts to the
  // real size on Escape or on unparsable input.
  const [draft, setDraft] = useState(String(size));
  useEffect(() => setDraft(String(size)), [size]);

  function commit() {
    const parsed = parseInt(draft, 10);
    if (Number.isFinite(parsed)) setTabFontSize(tabId, parsed);
    else setDraft(String(size));
  }

  return (
    <div className="context-menu-zoom-row">
      <button type="button" className="context-menu-zoom-btn" aria-label="Riduci zoom" onClick={() => zoomTabOut(tabId)}>
        −
      </button>
      <button type="button" className="context-menu-zoom-btn" aria-label="Aumenta zoom" onClick={() => zoomTabIn(tabId)}>
        +
      </button>
      <span
        className={"context-menu-zoom-value" + (isCustom ? " is-custom" : "")}
        title={isCustom ? `Diversa dal valore predefinito (${defaultSize}px)` : "Dimensione carattere di questo terminale"}
      >
        <input
          type="text"
          inputMode="numeric"
          className="context-menu-zoom-input"
          value={draft}
          aria-label="Dimensione carattere"
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(String(size));
              e.currentTarget.blur();
            }
          }}
        />
        <span className="context-menu-zoom-unit">px</span>
      </span>
      <button
        type="button"
        className="context-menu-zoom-btn context-menu-zoom-reset"
        aria-label="Ripristina dimensione predefinita"
        title="Ripristina dimensione predefinita"
        disabled={!isCustom}
        onClick={() => resetTabZoom(tabId)}
      >
        {Icons.zoomReset}
      </button>
    </div>
  );
}

/** A fresh tab's label before its shell reports a title of its own - the
 * full path, same as what the shell's own title will show (tabs never
 * collapse the home dir to `~`). */
function labelForCwd(cwd: string): string {
  return cwd || "shell";
}

/** Matches the "user@host: /some/path" shape most shells use for their OSC
 * title, capturing the user and the path. */
const TITLE_HOST_PREFIX = /^([^\s@]+)@[^\s:]+:\s*(.+)$/;

/** Keeps just the useful part of a shell title - shown as the shell reports
 * it, full path included. */
function cleanTitle(raw: string): string {
  const title = raw.trim();
  return title.match(TITLE_HOST_PREFIX)?.[2] ?? (title || "shell");
}

/** A cwd is never a file - but a brand new cmd.exe console on Windows starts
 * out titled with the full path to its OWN executable (e.g.
 * `C:\Windows\System32\cmd.exe`), before anything has set a real title. The
 * same thing happens launching Claude Code/Codex on Windows: if the shell
 * (or Windows console default-title fallback) reports the CLI's own script
 * path instead of a real title - an npm shim (`.cmd`/`.ps1`) or the Node
 * entry point itself (`.js`/`.mjs`/`.cjs`) - that also happens to pass
 * `isAbsolutePath`. Without this check a title update like that would stomp
 * `explorerPath` with the CLI's own script location instead of the actual
 * working directory, which then can't be `read_dir`'d (it's a file, not a
 * folder) and leaves the explorer pointed somewhere that looks "connected"
 * but shows nothing - and navigating up from there re-injects a `cd` into
 * whatever real session is still running in that shell. */
function looksLikeExecutablePath(path: string): boolean {
  return /\.(exe|com|bat|cmd|ps1|js|mjs|cjs)$/i.test(path);
}

/** cmd.exe retitles to "<cwd> - <command>" for as long as a command runs, so
 * a title-derived Windows path may carry that suffix - and a folder name can
 * legitimately contain " - " too ("Foo - Copia"). Longest first: the path as
 * reported, then each shorter prefix cut at a " - ". */
function cmdTitlePathCandidates(path: string): string[] {
  const candidates = [path];
  for (let i = path.lastIndexOf(" - "); i > 0; i = path.lastIndexOf(" - ", i - 1)) {
    candidates.push(path.slice(0, i));
  }
  return candidates;
}

/** The first of `candidates` that is an existing directory, if any. */
async function firstExistingDir(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await invoke<boolean>("is_directory", { path: candidate }).catch(() => false)) return candidate;
  }
  return undefined;
}

let nextTabId = 1;

function Shell() {
  // All persisted across restarts - every toggle path (header button,
  // shortcut, floating backdrop, the agents panel's own X, Settings...) goes
  // through these setters, so persisting in one place covers all of them.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(SIDEBAR_COLLAPSED_KEY, readFalse, writeBool);
  const [agentsSidebarOpen, setAgentsSidebarOpen] = usePersistentState(AGENTS_SIDEBAR_OPEN_KEY, readFalse, writeBool);
  const [sidebarMode, setSidebarMode] = usePersistentState<SidebarMode>(SIDEBAR_MODE_KEY, readSidebarMode, writeString);
  const [explorerLinkMode, setExplorerLinkMode] = usePersistentState<ExplorerLinkMode>(
    EXPLORER_LINK_MODE_KEY,
    readLinkMode,
    writeString,
  );
  const [quickActionIds, setQuickActionIds] = usePersistentState<string[]>(QUICK_ACTIONS_KEY, readQuickActions, writeJson);
  const [favoritesButtonVisible, setFavoritesButtonVisible] = usePersistentState(
    FAVORITES_BUTTON_VISIBLE_KEY,
    readTrue,
    writeBool,
  );
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
  const latestRef = useRef({ tabs, activeTabId, activeTerminalId });
  latestRef.current = { tabs, activeTabId, activeTerminalId };
  const [isMaximized, setIsMaximized] = useState(false);
  const [isEdgeFlush, setIsEdgeFlush] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
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
  // A one-off shell override for a tab about to be created (the "+" button's
  // own context menu picking a specific shell, e.g. WSL, instead of the
  // configured default) - read once by that tab's TerminalView via its
  // shellOverride prop (see the render loop below), same lifecycle as
  // pendingCommandsRef above.
  const pendingShellOverrideRef = useRef(new Map<string, string>());
  const editorRefs = useRef(new Map<string, EditorHandle>());
  // A terminal session moved here from another window, keyed by its new tab
  // id - handed to that tab's TerminalView once, at mount (its `attach`).
  const pendingAttachRef = useRef(new Map<string, TerminalTransfer>());
  // Same for an editor tab moved here with unsaved edits.
  const pendingEditorContentRef = useRef(new Map<string, string>());
  const pluginBtnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmDialog();
  const openMenu = useOpenContextMenu();
  const { hide: hideMenu } = useContextMenu();
  const { mode, toggleTheme, setMode } = useTheme();
  const { startPath, resetTabZoom, restoreSession, shellId, tabFontSizeOverrides, setTabFontSize } = useTerminalSettings();
  const restoreSessionRef = useRef(restoreSession);
  restoreSessionRef.current = restoreSession;
  // Previous session's terminal text, keyed by the restored tab's new id -
  // handed to its TerminalView once, at mount (see `restoredContent`).
  const restoredContentRef = useRef(new Map<string, string>());
  // Terminal tabs brought back from the previous session - an untouched one
  // is still worth keeping (it has history), unlike a virgin fresh tab.
  const restoredTabIdsRef = useRef(new Set<string>());
  // Nothing may spawn, and nothing may be saved, until the previous session
  // has been read back (or skipped) - otherwise the startup tab would start
  // a shell that's about to be replaced, and the first save would overwrite
  // the file before it was ever read.
  const [sessionChecked, setSessionChecked] = useState(false);

  function toggleQuickAction(id: string) {
    setQuickActionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function pinToQuickActions(ids: string[]) {
    if (ids.length === 0) return;
    setQuickActionIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
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

      if (!readString(PLUGINS_MIGRATED_KEY)) {
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

      // The installer's "Integrazioni" step: enable and pin exactly what was
      // picked there (reinstalls included - an already-present plugin just
      // gets re-pinned), and skip the blanket seeding below, which would
      // otherwise add back whatever was left unchecked.
      const chosen = await invoke<string[] | null>("take_installer_features").catch(() => null);
      if (chosen) {
        const chosenIds: string[] = [];
        for (const manifest of EXAMPLE_PLUGINS) {
          if (!chosen.includes(manifest.id)) continue;
          if (!byId.has(manifest.id)) await invoke("save_plugin", { plugin: manifest });
          chosenIds.push(manifest.id);
        }
        pinToQuickActions(chosenIds);
        writeString(PLUGINS_SEEDED_KEY, "1");
      }

      if (!readString(PLUGINS_SEEDED_KEY)) {
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
    writeString(PLUGINS_MIGRATED_KEY, "1");
    writeString(PLUGINS_SEEDED_KEY, "1");
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
    invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => setHomeDir("/"));
  }, []);

  // The configured start path (Settings > Terminale) may since have been
  // deleted/unmounted, so it's re-checked here rather than trusted outright -
  // an invalid one just falls back to home instead of handing pty_spawn a
  // cwd that no longer exists.
  const [resolvedStartPath, setResolvedStartPath] = useState("");
  // Whether that check has settled at least once - the startup tab waits on
  // it (see below), since `home_dir` usually resolves first and would
  // otherwise spawn the very first shell at home before the configured
  // start folder is known.
  const [startPathChecked, setStartPathChecked] = useState(false);
  useEffect(() => {
    if (!startPath) {
      setResolvedStartPath("");
      setStartPathChecked(true);
      return;
    }
    let cancelled = false;
    invoke<boolean>("is_directory", { path: startPath })
      .then((ok) => {
        if (!cancelled) setResolvedStartPath(ok ? startPath : "");
      })
      .catch(() => {
        if (!cancelled) setResolvedStartPath("");
      })
      .finally(() => {
        if (!cancelled) setStartPathChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [startPath]);

  useEffect(() => {
    let cancelled = false;

    /** Rebuilds one saved window's tabs in this window. */
    async function applySavedWindow(saved: SavedWindow) {
      const restored: AppTab[] = [];
      for (const t of saved.tabs) {
        if (t.kind === "terminal") {
          // A folder deleted since, or a `\\wsl.localhost\...` path a
          // Windows shell can't start in (a WSL one can - pty_spawn turns
          // it into `wsl -d <distro> --cd <path>`): left empty, so the
          // startup-folder fill below gives it the configured start folder
          // instead.
          //
          // A session saved while a command was running in cmd.exe holds
          // its "<cwd> - <command>" title as the cwd (see
          // `cmdTitlePathCandidates`) - the real folder is recovered from
          // it rather than dropping the tab back to the start folder.
          const wslDistro = wslDistroOfShell(t.shell);
          const cwd =
            !!t.cwd && (wslDistro !== undefined || !t.cwd.startsWith("\\\\"))
              ? ((await firstExistingDir(wslDistro !== undefined ? [t.cwd] : cmdTitlePathCandidates(t.cwd))) ?? "")
              : "";
          const id = `tab-${nextTabId++}`;
          restoredTabIdsRef.current.add(id);
          if (t.content) restoredContentRef.current.set(id, t.content);
          if (t.shell) pendingShellOverrideRef.current.set(id, t.shell);
          restored.push({
            kind: "terminal",
            id,
            cwd,
            explorerPath: cwd,
            label: t.customLabel || !cwd ? t.label : labelForCwd(cwd),
            customLabel: t.customLabel,
            nestedShell: wslDistro !== undefined ? "wsl" : undefined,
            wslDistro: wslDistro ?? undefined,
          });
        } else if (t.kind === "editor") {
          restored.push({ kind: "editor", id: `editor-${nextTabId++}`, path: t.path, label: t.label });
        } else if (!restored.some((r) => r.kind === "settings")) {
          restored.push({ kind: "settings", id: "settings", label: "Impostazioni" });
        }
      }
      if (cancelled) return;
      if (!restored.some((r) => r.kind === "terminal")) {
        restored.unshift({ kind: "terminal", id: "tab-0", cwd: "", explorerPath: "", label: "shell" });
      }
      const active = restored[Math.min(Math.max(saved.activeIndex, 0), restored.length - 1)];
      setTabs(restored);
      setActiveTabId(active.id);
      setActiveTerminalId(active.kind === "terminal" ? active.id : restored.find((r) => r.kind === "terminal")!.id);
    }

    (async () => {
      const init = await takeWindowInit();
      if (cancelled) return;
      if (init?.kind === "adopt") {
        adoptTabRef.current(init.transfer, true);
      } else if (init?.kind === "restore") {
        await applySavedWindow(init.window);
      } else if (isMainWindow && restoreSessionRef.current) {
        const saved = await loadSession();
        if (saved && !cancelled) {
          await applySavedWindow(saved[0]);
          // Every other saved window reopens as a window of its own, where
          // it was.
          for (const extra of saved.slice(1)) {
            const placement = extra.bounds ? { kind: "bounds", ...extra.bounds } : { kind: "atCursor" };
            invoke("window_open", { init: { kind: "restore", window: extra }, placement }).catch(() => {});
          }
        }
      }
      if (!cancelled) setSessionChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionChecked) return;
    async function snapshot(): Promise<SavedWindow> {
      const { tabs, activeTabId } = latestRef.current;
      // A virgin terminal (opened, never typed into or used) isn't worth
      // bringing back. A restored one left untouched is saved with the very
      // content it was restored with, not a fresh serialize - otherwise
      // every restart would append the new shell's prompt below it again.
      const kept = tabs.filter((t) => {
        if (t.kind !== "terminal") return true;
        return restoredTabIdsRef.current.has(t.id) || !!termRefs.current.get(t.id)?.wasUsed();
      });
      // Where an extra window reopens next time (the main one keeps its
      // default placement). Not while minimized: Windows parks a minimized
      // window far off-screen.
      let bounds: SavedWindow["bounds"];
      if (!isMainWindow && !(await appWindow.isMinimized().catch(() => false))) {
        const geometry = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]).catch(() => null);
        if (geometry) {
          const [pos, size] = geometry;
          bounds = { x: pos.x, y: pos.y, width: size.width, height: size.height };
        }
      }
      return {
        bounds,
        activeIndex: Math.max(0, kept.findIndex((t) => t.id === activeTabId)),
        tabs: kept.map((t): SavedTab => {
          if (t.kind === "terminal") {
            const term = termRefs.current.get(t.id);
            return {
              kind: "terminal",
              cwd: t.cwd,
              label: t.label,
              customLabel: t.customLabel,
              shell: tabShell(t),
              content: term?.wasUsed() ? term.serialize() : restoredContentRef.current.get(t.id),
            };
          }
          if (t.kind === "editor") return { kind: "editor", path: t.path, label: t.label };
          return { kind: "settings" };
        }),
      };
    }
    // Setting off: overwrite with an empty session rather than leave a stale
    // one around for whenever it's switched back on. Each window reports
    // only its own part; the backend writes the file (see session.rs).
    const persist = async (flushGen?: number) => {
      const snap = restoreSessionRef.current ? await snapshot() : null;
      await saveWindowSession(snap, flushGen).catch(() => {});
    };
    // Right away too, so a freshly opened window is part of the session
    // from the start.
    void persist();
    // Periodic too, not just on close - a crash or a killed process never
    // gets a close event.
    const timer = setInterval(() => void persist(), 15000);
    const unlisten = appWindow.onCloseRequested(async () => {
      await persist();
    });
    // The backend asking every window for its latest state - right before
    // quitting for an update (see updater.rs).
    const unlistenFlush = listen<number>("session:flush", (e) => void persist(e.payload));
    return () => {
      clearInterval(timer);
      unlisten.then((off) => off());
      unlistenFlush.then((off) => off());
    };
  }, [sessionChecked]);

  useEffect(() => {
    if (!homeDir || !startPathChecked || !sessionChecked) return;
    const initial = resolvedStartPath || homeDir;
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "terminal" && t.cwd === ""
          ? // A restored tab whose folder is gone still keeps the name the
            // user gave it.
            { ...t, cwd: initial, explorerPath: initial, label: t.customLabel ? t.label : labelForCwd(initial) }
          : t,
      ),
    );
  }, [homeDir, resolvedStartPath, startPathChecked, sessionChecked]);

  useEffect(() => {
    // Windows Snap (tiling two windows side by side) is not "maximized" as
    // far as `isMaximized()` (win32 `IsZoomed`) is concerned - the window is
    // just resized to half the work area. But a snapped window always spans
    // the full work-area height, so it's flush against the top and bottom
    // screen edges the same way a real maximized window is; without this,
    // the floating window's 1px border (and DWM's own rounded corners, see
    // the effect below) stay on and read as a stray outline/notch against
    // the screen edge and the neighboring window.
    const updateMaximizedState = async () => {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
      appWindow.isFullscreen().then(setIsFullscreen).catch(() => {});
      if (maximized) {
        setIsEdgeFlush(false);
        return;
      }
      try {
        const monitor = await currentMonitor();
        if (!monitor) {
          setIsEdgeFlush(false);
          return;
        }
        const [pos, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        // All four values are physical pixels: `outerPosition`/`outerSize` come
        // from win32 `GetWindowRect` and `workArea` from `GetMonitorInfoW`'s
        // `rcWork`, both unscaled. Don't mix in `scaleFactor` here.
        const { position: workPos, size: workSize } = monitor.workArea;
        // Generous tolerance: Windows 11's "show a small gap between snapped
        // windows" setting insets a snapped window a few px from the work
        // area on top of normal DPI-scaling rounding, so an exact (or
        // near-exact) match is too strict to ever fire. (Measured on a real
        // Snap here the match is in fact exact, but leave room for the gap
        // setting and for other DPI configurations.)
        const EDGE_TOLERANCE = 24;
        const flushTop = Math.abs(pos.y - workPos.y) <= EDGE_TOLERANCE;
        const flushBottom = Math.abs(pos.y + size.height - (workPos.y + workSize.height)) <= EDGE_TOLERANCE;
        setIsEdgeFlush(flushTop && flushBottom);
      } catch (err) {
        // Don't swallow silently: a bad API call here looks exactly like "the
        // window simply isn't snapped", which hid an `appWindow.currentMonitor`
        // TypeError for a long time.
        console.error("[snap-detect] failed to read window/monitor geometry", err);
        setIsEdgeFlush(false);
      }
    };
    updateMaximizedState();
    const recheck = () => {
      updateMaximizedState();
      // Windows Snap animates the window into place - re-check once the
      // animation has almost certainly settled, in case the event fired
      // mid-animation and read a not-yet-final position.
      setTimeout(updateMaximizedState, 250);
    };
    // `onMoved` as well as `onResized`: snapping from one half to the other
    // (or dragging a full-height window onto another monitor) changes the
    // position without changing the size, so WM_SIZE - and therefore
    // `onResized` - never fires.
    const unlisten = Promise.all([appWindow.onResized(recheck), appWindow.onMoved(recheck)]);
    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    // DWM rounds this window's corners unconditionally (see
    // apply_window_chrome/set_window_corner_rounding in shared/src/lib.rs);
    // that only goes unnoticed on a floating window. Flush against the
    // screen edge or a neighboring Snapped window, the rounded clip nicks a
    // visible notch out of the corner, so square it off there instead.
    invoke("set_window_square_corners", { square: isMaximized || isEdgeFlush || isFullscreen }).catch(() => {});
  }, [isMaximized, isEdgeFlush, isFullscreen]);

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

  // Copy/paste only make sense with a terminal on screen - an editor or
  // input keeps its own native clipboard handling.
  const activeTermHandle = () => (activeTabId === activeTerminalId ? termRefs.current.get(activeTerminalId) : undefined);
  useShortcuts({
    toggleSidebar: () => setSidebarCollapsed((c) => !c),
    clearTerminal: () => termRefs.current.get(activeTerminalId)?.clear(),
    copy: () => activeTermHandle()?.copySelection(),
    paste: () => activeTermHandle()?.paste(),
    newTab: () => addTab(),
    closeTab: () => closeTab(activeTabId),
    toggleTheme: () => toggleTheme(),
  });

  function selectTab(id: string) {
    setActiveTabId(id);
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    if (tab?.kind === "terminal") setActiveTerminalId(id);
  }
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;

  function addTab(cwdOverride?: string, shellOverride?: string): string {
    // No longer inherits the active tab's cwd - a fresh tab always starts at
    // the configured start folder (Impostazioni > Cartella di avvio), which
    // defaults to the user's home dir when left unset, same as
    // `resolvedStartPath`'s own fallback below. `cwdOverride` is still how a
    // caller that *does* want a specific folder (duplicateTab, opening a
    // favorite, resuming an agent session) gets one.
    const cwd = cwdOverride || resolvedStartPath || homeDir;
    const id = `tab-${nextTabId++}`;
    // A `\\wsl.localhost\<distro>\...` folder only a WSL shell can start in,
    // whatever the caller (or the configured default) would have picked.
    const pathDistro = wslDistroOfPath(cwd);
    if (pathDistro && wslDistroOfShell(shellOverride ?? shellId) === undefined) shellOverride = wslShellId(pathDistro);
    if (shellOverride) pendingShellOverrideRef.current.set(id, shellOverride);
    // A tab whose shell *is* wsl.exe from the moment it spawns never goes
    // through the "user typed `wsl`" detection in handleCommandLine below -
    // there's no host shell first for them to type into - so without this
    // its first WSL prompt's title update is read as a plain host path
    // (nestedShell undefined) and the explorer just never follows it in.
    // `cwd` above is still a host path (there's no host shell to have had a
    // real one) - same placeholder-until-corrected behavior as typing `wsl`
    // into an existing tab, fixed up by applyWslTitle the moment the first
    // prompt reports the distro's actual cwd.
    const wslDistro = wslDistroOfShell(shellOverride ?? shellId);
    const nestedShell = wslDistro !== undefined ? "wsl" : undefined;
    setTabs((prev) => [
      ...prev,
      {
        kind: "terminal",
        id,
        cwd,
        explorerPath: cwd,
        label: labelForCwd(cwd),
        nestedShell,
        wslDistro: pathDistro ?? wslDistro ?? undefined,
      },
    ]);
    setActiveTabId(id);
    setActiveTerminalId(id);
    return id;
  }

  /** What's at the front of a tab's terminal right now - see shellDialect.ts. */
  function tabForeground(tabId: string): Promise<Foreground | null> {
    return ptyForeground(termRefs.current.get(tabId)?.getPtyId());
  }

  /** Runs `command` in a new tab in the same folder and shell as `tabId` -
   * for a command meant for a tab whose input is owned by a running program
   * (a dev server, an editor, an agent): typed there, it would be garbage
   * input to that program instead of a command. Returns the new tab's id. */
  function runInTabLike(tabId: string, command: string): string {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const id = addTab(tab?.cwd, tab ? tabShell(tab) : undefined);
    pendingCommandsRef.current.set(id, command);
    return id;
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
  async function openAgentSession(cwd: string, sessionId: string, cli: "claude" | "codex", wslDistro?: string) {
    if (wslDistro) {
      // Saved inside WSL: resumed by the distro's own CLI, in a WSL tab
      // opened on that folder (`cwd` is a Linux path there). The
      // `--no-daemon` check is about Windows' Job Object - not WSL's concern.
      const command = cli === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
      const id = addTab(toWindowsPath(wslDistro, cwd), wslShellId(wslDistro));
      pendingCommandsRef.current.set(id, command);
      return;
    }
    const command =
      cli === "claude" ? `claude --resume ${sessionId}` : await withCodexLaunchFlags(`codex resume ${sessionId}`);
    const id = `tab-${nextTabId++}`;
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, { kind: "terminal", id, cwd, explorerPath: cwd, label: labelForCwd(cwd) }]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** The `pty_spawn` shell id a new terminal needs to land in the same kind
   * of session `tab` is in right now - so "Apri in un altro terminale", a
   * duplicated tab or a favorite saved from a WSL session opens in WSL (same
   * distro), where its path actually exists, and one from a tab opened as
   * PowerShell/cmd/... opens in that same shell. `undefined` = the tab runs
   * the configured default. A path inside a distro's share always means WSL,
   * even once a nested agent/remote session froze the tab (which clears
   * `wslDistro`). */
  function tabShell(tab: TermTab): string | undefined {
    if (tab.nestedShell === "wsl") return wslShellId(tab.wslDistro);
    const pathDistro = wslDistroOfPath(tab.explorerPath || tab.cwd);
    if (pathDistro) return wslShellId(pathDistro);
    return pendingShellOverrideRef.current.get(tab.id);
  }

  /** Opens a saved favorite: in the active terminal (a silent `cd`, same as
   * browsing there from the explorer) when it's the same kind of terminal
   * the favorite was saved from, otherwise in a new tab running that shell -
   * a WSL folder can't be reached from cmd/PowerShell, and a folder saved
   * from PowerShell shouldn't suddenly open in WSL. */
  function openFavorite(fav: FavoriteFolder) {
    const pathDistro = wslDistroOfPath(fav.path);
    const shell = fav.shell ?? (pathDistro ? wslShellId(pathDistro) : undefined);
    const current = activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined;
    if (!shell || !activeTerminal || sameShell(shell, current)) {
      browseExplorer(fav.path);
      return;
    }
    addTab(fav.path, shell);
  }

  /** A second, independent tab alongside `id` - same cwd for a terminal
   * (via addTab's own cwdOverride), same file for an editor (bypassing
   * openFile's own "already open, just switch to it" dedupe, since
   * duplicating an already-open file is exactly asking for a second tab on
   * it). Settings has nothing to duplicate (a singleton tab - see
   * openSettings) so it's simply not offered there (see TabStrip's own menu). */
  function duplicateTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "terminal") {
      addTab(tab.cwd, tabShell(tab));
      return;
    }
    if (tab.kind === "editor") {
      const newId = `editor-${nextTabId++}`;
      setTabs((prev) => [...prev, { kind: "editor", id: newId, path: tab.path, label: tab.label }]);
      setActiveTabId(newId);
    }
  }

  function openFile(path: string) {
    const name = basename(path);
    if (!isLikelyTextFile(name)) {
      // Not something the built-in editor can show (image, PDF, archive...):
      // handed to the OS default app instead. The explorer already lists a
      // WSL tab's files by their Windows form, but a bare POSIX path from one
      // is translated too - Windows can't open `/home/...` as-is.
      const wslTab = activeTerminal?.nestedShell === "wsl" ? activeTerminal : undefined;
      const hostPath = wslTab?.wslDistro && path.startsWith("/") ? toWindowsPath(wslTab.wslDistro, path) : path;
      invoke("open_with_default_app", { path: hostPath }).catch((e) =>
        showPluginToast(`Impossibile aprire ${name}: ${e}`),
      );
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

  function reorderTab(id: string, toIndex: number) {
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id);
      if (from === -1 || from === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
      return next;
    });
  }

  /** Receives a tab from another window (or, `replaceAll`, as the very
   * first content of a window opened for it). Its id is re-issued here - ids
   * are only unique per window. */
  function adoptTab(transfer: TabTransfer, replaceAll = false) {
    const { tab } = transfer;
    let adopted: AppTab;
    if (tab.kind === "terminal") {
      const id = `tab-${nextTabId++}`;
      if (transfer.terminal) {
        pendingAttachRef.current.set(id, { ptyId: transfer.terminal.ptyId, snapshot: transfer.terminal.snapshot });
        if (transfer.terminal.shell) pendingShellOverrideRef.current.set(id, transfer.terminal.shell);
        if (transfer.terminal.fontSize !== undefined) setTabFontSize(id, transfer.terminal.fontSize);
      }
      adopted = { ...tab, id };
    } else if (tab.kind === "editor") {
      const id = `editor-${nextTabId++}`;
      if (transfer.editor?.dirty) pendingEditorContentRef.current.set(id, transfer.editor.content);
      adopted = { ...tab, id };
    } else {
      adopted = { kind: "settings", id: "settings", label: "Impostazioni" };
    }

    if (replaceAll) {
      // A window always has a terminal: one opened for an editor/settings
      // tab keeps its startup terminal next to it.
      setTabs((prev) => (adopted.kind === "terminal" ? [adopted] : [...prev.filter((t) => t.kind === "terminal"), adopted]));
    } else if (adopted.kind === "settings" && latestRef.current.tabs.some((t) => t.kind === "settings")) {
      // Already open here (it's a singleton): just switch to it.
    } else {
      const index = tabStripDropIndex(transfer.drop);
      setTabs((prev) => {
        const next = [...prev];
        next.splice(index ?? next.length, 0, adopted);
        return next;
      });
    }
    setActiveTabId(adopted.id);
    if (adopted.kind === "terminal") setActiveTerminalId(adopted.id);
  }
  // Tells the backend which terminal tabs this window has, and which pty
  // each one runs - so the Agents panel of every window can list (and jump
  // to) agents running here. Re-sent periodically: a new tab's pty id only
  // exists once its shell has spawned.
  useEffect(() => {
    const report = () =>
      invoke("window_report_tabs", {
        tabs: latestRef.current.tabs
          .filter((t): t is TermTab => t.kind === "terminal")
          .map((t) => ({ pty_id: termRefs.current.get(t.id)?.getPtyId() ?? null, tab_id: t.id, label: t.label, cwd: t.cwd })),
      }).catch(() => {});
    report();
    const timer = setInterval(report, 3000);
    return () => clearInterval(timer);
  }, [tabs]);

  const adoptTabRef = useRef(adoptTab);
  adoptTabRef.current = adoptTab;

  useEffect(() => {
    const webview = getCurrentWebviewWindow();
    const unlisten = webview.listen<TabTransfer>("tab:adopt", (e) => {
      adoptTabRef.current(e.payload);
      appWindow.setFocus().catch(() => {});
    });
    // Another window's Agents panel sending the user to one of our tabs.
    const unlistenFocus = webview.listen<string>("tab:focus", (e) => selectTabRef.current(e.payload));
    return () => {
      unlisten.then((off) => off());
      unlistenFocus.then((off) => off());
    };
  }, []);

  /** Everything the receiving window needs to rebuild `tab` - for a terminal
   * this detaches its running session from this window (see
   * `TerminalHandle.release`). `null` when it can't move (a terminal whose
   * shell hasn't started yet). */
  async function packTab(tab: AppTab): Promise<TabTransfer | null> {
    if (tab.kind === "terminal") {
      const moved = await termRefs.current.get(tab.id)?.release();
      if (!moved) return null;
      return { tab, terminal: { ...moved, shell: tabShell(tab), fontSize: tabFontSizeOverrides[tab.id] } };
    }
    if (tab.kind === "editor") {
      const handle = editorRefs.current.get(tab.id);
      return { tab, editor: handle ? { content: handle.getContent(), dirty: handle.isDirty() } : undefined };
    }
    return { tab };
  }

  /** Takes a moved-away tab out of this window without closing anything -
   * its session lives on in the other window. A window left with no
   * terminal gets a fresh one (there's always at least one). */
  function removeMovedTab(id: string) {
    const current = latestRef.current;
    const idx = current.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    let next = current.tabs.filter((t) => t.id !== id);
    if (next.length > 0 && !next.some((t) => t.kind === "terminal")) {
      const cwd = resolvedStartPath || homeDir;
      next = [...next, { kind: "terminal", id: `tab-${nextTabId++}`, cwd, explorerPath: cwd, label: labelForCwd(cwd) }];
    }
    if (id === current.activeTabId) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (!next.some((t) => t.id === current.activeTerminalId)) {
      const fallbackTerminal = next.find((t) => t.kind === "terminal");
      if (fallbackTerminal) setActiveTerminalId(fallbackTerminal.id);
    }
    setTabs(next);
    forgetTab(id);
  }

  /** A tab dragged out of the tab strip and released - see TabStrip. Where
   * it lands depends on what's under the cursor: another Flowcode window
   * takes it in; empty desktop (or this same window, away from its tab
   * strip) gets a new window for it. Dragging a window's only tab just
   * carries the whole window along, or merges it into the window it's
   * dropped on. */
  async function handleTabDragOut(id: string) {
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    if (!tab) return;
    const target = await invoke<CursorTarget>("window_at_cursor").catch(() => null);
    if (!target) return;
    const alone = latestRef.current.tabs.length === 1;
    const otherWindow = target.label !== null && target.label !== appWindow.label ? target.label : null;
    if (!otherWindow && alone) {
      if (target.label === null) await invoke("window_move_to_cursor").catch(() => {});
      return;
    }
    const transfer = await packTab(tab);
    if (!transfer) return;
    if (!alone) removeMovedTab(id);
    try {
      if (otherWindow) {
        await emitTo(otherWindow, "tab:adopt", { ...transfer, drop: { x: target.x, y: target.y } });
      } else {
        await invoke("window_open", { init: { kind: "adopt", transfer }, placement: { kind: "atCursor" } });
      }
    } catch {
      // Nowhere to go after all: it comes back here, still running.
      if (!alone) adoptTab(transfer);
      return;
    }
    if (alone) appWindow.close();
  }

  /** Drops the per-tab bookkeeping kept outside `tabs` itself. */
  function forgetTab(id: string) {
    termRefs.current.delete(id);
    editorRefs.current.delete(id);
    pendingCommandsRef.current.delete(id);
    pendingShellOverrideRef.current.delete(id);
    pendingAttachRef.current.delete(id);
    pendingEditorContentRef.current.delete(id);
    resetTabZoom(id);
    setDirtyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "terminal") {
      // Closing the very last tab of any kind (nothing else open - no
      // editor, no settings) mirrors how a plain terminal app behaves:
      // there's nothing left to show, so quit rather than leave an empty
      // shell of a window around. Editor/settings tabs still open take
      // priority - closing just falls through to the "replace in place"
      // branch below instead, so nothing else gets torn down unprompted.
      if (tabs.length === 1) {
        appWindow.close();
        return;
      }
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
            t.id === id ? { kind: "terminal", id: newId, cwd, explorerPath: cwd, label: labelForCwd(cwd) } : t,
          ),
        );
        setActiveTabId(newId);
        setActiveTerminalId(newId);
        termRefs.current.delete(id);
        pendingCommandsRef.current.delete(id);
        pendingShellOverrideRef.current.delete(id);
        resetTabZoom(id);
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
    // Read through refs, not the `tabs`/active ids captured when this call
    // started: the confirm above can stay open for a while, and title/cwd
    // updates that landed on other tabs meanwhile must not be overwritten
    // with that stale snapshot.
    const current = latestRef.current;
    const idx = current.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = current.tabs.filter((t) => t.id !== id);
    if (id === current.activeTabId) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (id === current.activeTerminalId) {
      const fallbackTerminal = next.find((t) => t.kind === "terminal");
      if (fallbackTerminal) setActiveTerminalId(fallbackTerminal.id);
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
    forgetTab(id);
  }

  /** Recognizes the user having typed `wsl`, `ssh ...` or an interactive
   * `docker exec/run -it` (see the shadow line-buffer in Terminal.tsx) -
   * the terminal-inside-the-terminal cases `handleTitleChange` below needs
   * to treat differently from a plain local `cd`. */
  function handleCommandLine(tabId: string, line: string) {
    const trimmed = line.trim();

    const wslMatch = trimmed.match(/^wsl(?:\.exe)?(?:\s+(.*))?$/i);
    if (wslMatch) {
      const rest = wslMatch[1] ?? "";
      const distroMatch = rest.match(/(?:^|\s)(?:-d|--distribution)\s+(\S+)/i);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId && t.kind === "terminal" ? { ...t, nestedShell: "wsl", wslDistro: distroMatch?.[1] } : t,
        ),
      );
      return;
    }

    const isInteractiveDocker =
      /^docker\s+(exec|run)\b/i.test(trimmed) && /(^|\s)(-it|-ti)(\s|$)|--interactive\b/i.test(trimmed);
    if (/^ssh\s+\S/i.test(trimmed) || isInteractiveDocker) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId && t.kind === "terminal" ? { ...t, nestedShell: "remote", wslDistro: undefined } : t,
        ),
      );
      return;
    }

    // Same tracking as `markAgentLaunching` (see its doc comment), but for
    // the CLI typed straight into the prompt rather than launched through a
    // shortcut - `checkCliAndMaybeLaunch` only ever sees the shortcut path.
    if (/^(claude|codex)(\.exe)?(?:\s|$)/i.test(trimmed)) {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, nestedShell: "agent", wslDistro: undefined } : t)),
      );
    }
  }

  /** Turns a WSL session's reported POSIX path into the Windows form the
   * explorer can browse (`\\wsl.localhost\...`, or a plain `C:\...` for the
   * distro's `/mnt` drive mounts - see `toWindowsPath`), and applies it to
   * the tab.
   *
   * Async because both halves may need looking up: the distro name (a bare
   * `wsl` with no `-d`) and the session's home dir (any `~`-shaped title,
   * i.e. the whole home tree - which is where `wsl` drops you, so it's the
   * normal case). Both lookups are memoized, so this costs one wsl.exe call
   * per distro+user for the whole app session. Crucially the path travels
   * *with* the lookup instead of the title update being dropped while one is
   * in flight: bash emits its title once per prompt, so a dropped update
   * would strand the explorer on the host path until the user happened to
   * run another command - which is what "the explorer disconnects the moment
   * I enter WSL" looked like. */
  async function applyWslTitle(tabId: string, distro: string | undefined, user: string | undefined, path: string) {
    const resolvedDistro = distro || (await defaultWslDistro());
    if (!resolvedDistro) return;
    let posixPath = path;
    if (posixPath === "~" || posixPath.startsWith("~/")) {
      const home = await wslHomeDir(resolvedDistro, user);
      if (!home) return;
      posixPath = home + posixPath.slice(1);
    }
    if (!posixPath.startsWith("/")) return;
    const winPath = toWindowsPath(resolvedDistro, posixPath);
    setTabs((prev) =>
      prev.map((t) =>
        // Still the same WSL session? The user may have exited back to the
        // host shell (which clears `nestedShell`) while a lookup ran.
        t.id === tabId && t.kind === "terminal" && t.nestedShell === "wsl"
          ? { ...t, cwd: winPath, explorerPath: winPath, wslDistro: resolvedDistro }
          : t,
      ),
    );
  }

  function handleTitleChange(tabId: string, rawTitle: string) {
    const trimmed = rawTitle.trim();
    const hostPrefix = trimmed.match(TITLE_HOST_PREFIX);
    const reportedUser = hostPrefix?.[1];
    const reportedPath = hostPrefix ? hostPrefix[2] : trimmed;
    const isWindows = isWindowsPlatform();

    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const label = t.customLabel ? t.label : cleanTitle(trimmed);

        // `~` only expands against *this app's own host* home dir - correct
        // for a plain local shell, but meaningless for a nested WSL/remote
        // session's own (different, unknown to this app) home. Left
        // un-expanded there rather than turned into a bogus host path that
        // would wrongly look like "back on the host shell" and drop the
        // nested-shell tracking; a WSL tab's `~` is expanded further down
        // against the distro's own home instead, a remote's is dropped.
        const rawPath = t.nestedShell ? reportedPath : expandHome(reportedPath, homeDir);

        // A WSL shell collapses its home tree to `~` in the title it reports
        // (bash's `\w`), and `wsl` starts you right there - so unlike a host
        // shell's, a WSL tab's `~` can't be written off as "not a real cwd".
        // It's kept and expanded against the *distro's* home in
        // `applyWslTitle` below, where the lookup belongs.
        const isWslHomePath = t.nestedShell === "wsl" && (rawPath === "~" || rawPath.startsWith("~/"));
        if ((!isAbsolutePath(rawPath) && !isWslHomePath) || looksLikeExecutablePath(rawPath)) return { ...t, label };

        // A genuine Windows path means we're back on a real host shell,
        // whatever nested session we might have been tracking before - but
        // only a title that names a directory that actually exists counts as
        // one, whenever there's a nested session to drop. Windows-shaped
        // console noise is emitted *during* a nested session too, and it
        // isn't distinguishable from a real post-exit prompt by shape alone
        // the way wsl/remote's POSIX titles are:
        //   - `"agent"` (Claude Code/Codex) reports a resolved script or
        //     shim path, or an OS default-title fallback, while it owns the
        //     screen;
        //   - cmd.exe retitles to "<cwd> - <command>" for the whole time a
        //     command runs, so typing `wsl` produces a title like
        //     `C:\...\flowcode - wsl` *before* the distro's own first title
        //     lands - taking that at face value dropped the WSL tracking
        //     that had just been set up, one keystroke into the session.
        // So the candidate is verified against the filesystem first, the
        // same deferred-update pattern as the wsl path translation below
        // (this title update itself is left alone; a confirmed candidate is
        // applied once the check resolves).
        if (isWindowsHostPath(rawPath)) {
          const nested = t.nestedShell;
          if (nested) {
            invoke<boolean>("is_directory", { path: rawPath }).then((isDir) => {
              if (!isDir) return;
              setTabs((prev2) =>
                prev2.map((t2) =>
                  // Still the same nested session? Anything that moved on
                  // since (exited, launched an agent) owns the tab now.
                  t2.id === tabId && t2.kind === "terminal" && t2.nestedShell === nested
                    ? { ...t2, cwd: rawPath, explorerPath: rawPath, nestedShell: undefined, wslDistro: undefined }
                    : t2,
                ),
              );
            });
            return { ...t, label };
          }
          // "<cwd> - <command>" while a command runs in cmd.exe: taken at
          // face value it's a folder that doesn't exist - and whatever is
          // the cwd when the app closes is what session restore reopens.
          // Resolved against the filesystem instead (deferred, like above).
          if (rawPath.includes(" - ")) {
            const cwdBefore = t.cwd;
            void firstExistingDir(cmdTitlePathCandidates(rawPath)).then((dir) => {
              if (!dir) return;
              setTabs((prev2) =>
                prev2.map((t2) =>
                  // Unless a newer title already moved the tab on.
                  t2.id === tabId && t2.kind === "terminal" && !t2.nestedShell && t2.cwd === cwdBefore
                    ? { ...t2, cwd: dir, explorerPath: dir }
                    : t2,
                ),
              );
            });
            return { ...t, label, nestedShell: undefined, wslDistro: undefined };
          }
          return { ...t, cwd: rawPath, explorerPath: rawPath, label, nestedShell: undefined, wslDistro: undefined };
        }

        // From here `rawPath` is POSIX-shaped.
        if (t.nestedShell === "remote" || t.nestedShell === "agent") {
          // ssh / docker exec (this app has no way to read that filesystem)
          // or Claude Code/Codex (a real filesystem, but not what a POSIX-
          // shaped title fragment while its own TUI owns the screen would
          // mean here) - cwd/explorerPath are left exactly where they were
          // rather than pointed at a local path that means nothing.
          return { ...t, label };
        }
        if (t.nestedShell === "wsl" && isWindows) {
          // Deferred (see `applyWslTitle`) even when the distro is already
          // known, so every WSL title takes the same one path through the
          // `~`-expansion; the lookups behind it are memoized and the update
          // it applies is idempotent for a given title.
          void applyWslTitle(tabId, t.wslDistro, reportedUser, rawPath);
          return { ...t, label };
        }

        // A plain POSIX path with no nested-shell context recognized - the
        // real local cwd (this app running on macOS/Linux, most commonly).
        return { ...t, cwd: rawPath, explorerPath: rawPath, label };
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
    const label = basename(newPath);
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, path: newPath, label } : t)));
  }

  function handleBusyChange(tabId: string, busy: boolean) {
    setTabs((prev) => prev.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, busy } : t)));
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
   * as after a manually-typed `cd`. Skipped entirely while the explorer is
   * disconnected (by hand, or auto-suspended because a full-screen program
   * owns the shell) - the sidebar still moves, it just stops typing into it. */
  function browseExplorer(path: string) {
    const active = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
    // Whether the `cd` is typed, and in which shell's syntax, is decided by
    // asking the OS what's in front of the tab (see `cdShell`); alt-screen
    // `busy` is just a free early-out.
    if (explorerLinkMode === "auto" && !active?.busy) void cdShell(activeTerminalId, path);
    // `path` is whatever the explorer itself browses - for a WSL tab that's
    // the translated Windows form (see handleTitleChange).
    const posixPath = active?.nestedShell === "wsl" && active.wslDistro ? toWslPath(active.wslDistro, path) : null;
    // Round-tripped through the POSIX form so a click that lands *inside*
    // the distro's drive mounts (`...\Ubuntu\mnt` lists fine, and `c` is
    // right there in it) becomes the `C:\...` path that can actually be
    // read, rather than the share path that answers ERROR_ACCESS_DENIED -
    // exactly the rewrite `toWindowsPath` already does for a reported title.
    const browsePath =
      posixPath && active?.wslDistro ? toWindowsPath(active.wslDistro, posixPath) : path;
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTerminalId && t.kind === "terminal" ? { ...t, explorerPath: browsePath } : t)),
    );
  }

  /** Types the explorer's `cd` into `tabId`'s shell, in that shell's own
   * syntax - only when the OS reports a shell actually waiting at its prompt:
   * never into a running program, never into an ssh session (whose
   * filesystem isn't this one). For WSL, `path` (the Windows/UNC form the
   * explorer browses) is translated to the distro's POSIX one, and the tab's
   * WSL tracking is aligned with what the OS reports. */
  async function cdShell(tabId: string, path: string) {
    const term = termRefs.current.get(tabId);
    const fg = await tabForeground(tabId);
    if (!term || !fg || fg.kind === "program" || fg.kind === "remote") return;
    if (fg.kind !== "wsl") {
      term.navigateSilently(cdCommand(path, fg.kind));
      return;
    }
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const distro = fg.wsl_distro ?? tab?.wslDistro ?? (await defaultWslDistro());
    const posixPath = distro ? toWslPath(distro, path) : null;
    if (!distro || !posixPath) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.kind === "terminal" && (t.nestedShell !== "wsl" || !t.wslDistro)
          ? { ...t, nestedShell: "wsl", wslDistro: distro }
          : t,
      ),
    );
    term.navigateSilently(cdCommand(posixPath, "posix"));
  }

  const activeTerminal = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
  const sidebarCwd = activeTerminal?.explorerPath || homeDir;

  const allPlugins: PluginDef[] = [...BUILTIN_PLUGINS, ...customPlugins];

  function showPluginToast(message: string) {
    setPluginToast(message);
    if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    pluginToastTimerRef.current = setTimeout(() => setPluginToast(null), 2600);
  }

  /** Marks a tab as owned by an about-to-launch agent CLI *before* it's
   * actually typed into the shell - see the `nestedShell: "agent"` doc
   * comment in tabs/types.ts. Set from here rather than waiting for a title
   * update to imply it, so there's no window between the launch command
   * landing and the tracking kicking in for a title update racing it to
   * claim a bogus cwd. */
  function markAgentLaunching(tabId: string) {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, nestedShell: "agent", wslDistro: undefined } : t)),
    );
  }

  /** Before launching Claude Code / Codex, offers a one-click install (if
   * missing) or login (if installed but signed out) in a fresh terminal
   * instead of the shortcut just quietly doing nothing useful. `check_cli_status`
   * (src-tauri/src/plugins.rs) does the actual detection. */
  async function checkCliAndMaybeLaunch(
    cliBin: "claude" | "codex",
    launchCommand: string,
    term: TerminalHandle | undefined,
    tabId: string,
  ) {
    const label = cliBin === "claude" ? "Claude Code" : "Codex CLI";
    let status: { installed: boolean; logged_in: boolean };
    try {
      status = await invoke("check_cli_status", { cli: cliBin });
    } catch {
      // Detection itself failed - don't block the shortcut over it, just
      // fall back to the plain launch as before this check existed.
      await launchInTab(cliBin, launchCommand, term, tabId);
      return;
    }

    if (!status.installed) {
      const isWindows = isWindowsPlatform();
      const installCommand = cliInstallCommand(cliBin, isWindows);
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

    await launchInTab(cliBin, launchCommand, term, tabId);
  }

  /** Types the CLI's launch command into `tabId` when a shell is at its
   * prompt there, or runs it in a new tab alongside when something else
   * already owns that tab's input (see `runInTabLike`). */
  async function launchInTab(cliBin: "claude" | "codex", launchCommand: string, term: TerminalHandle | undefined, tabId: string) {
    const fg = await tabForeground(tabId);
    // Codex needs `--no-daemon` when Flowcode's host Job Object won't let
    // its background server detach - see plugins/codexLaunch.ts. That's this
    // host's own codex: not one inside WSL or across ssh.
    const hostCodex = cliBin === "codex" && fg?.kind !== "wsl" && fg?.kind !== "remote";
    const command = hostCodex ? await withCodexLaunchFlags(launchCommand) : launchCommand;
    if (fg && !atShellPrompt(fg)) {
      markAgentLaunching(runInTabLike(tabId, command));
      return;
    }
    markAgentLaunching(tabId);
    term?.runCommandSilently(command);
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
          checkCliAndMaybeLaunch(cliBin, plugin.command, term, activeTerminalId);
        } else {
          const tabId = activeTerminalId;
          const command = plugin.command;
          void tabForeground(tabId).then((fg) => {
            if (fg && !atShellPrompt(fg)) runInTabLike(tabId, command);
            else term?.runCommand(command);
          });
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
        key={editorTab.id}
        label={editorTab.label}
        getContent={() => editorRefs.current.get(editorTab.id)?.getContent() ?? ""}
        onJump={(line) => editorRefs.current.get(editorTab.id)?.scrollToLine(line)}
      />
    );
  } else {
    sidebarPanel = (
      <Sidebar
        cwd={sidebarCwd}
        onNavigate={browseExplorer}
        onOpenFile={openFile}
        onOpenTerminal={(path) => addTab(path, activeTerminal ? tabShell(activeTerminal) : undefined)}
        shell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
        linkMode={explorerLinkMode}
        onSetLinkMode={setExplorerLinkMode}
        terminalBusy={activeTerminal?.busy ?? false}
      />
    );
  }

  function toggleFullscreen() {
    appWindow
      .setFullscreen(!isFullscreen)
      .then(() => setIsFullscreen((f) => !f))
      .catch(() => {});
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
        custom: <ZoomRow tabId={activeTerminalId} />,
      },
      { separator: true, label: "sep-zoom" },
      { label: "Nuovo terminale", icon: Icons.newTerminal, onSelect: () => addTab() },
      {
        label: isFullscreen ? "Esci da schermo intero" : "Schermo intero",
        icon: isFullscreen ? Icons.fullscreenExit : Icons.fullscreen,
        onSelect: toggleFullscreen,
      },
      {
        label: "Preferiti",
        icon: <StarIcon />,
        submenu: [
          favoritesMenuItem({
            activeCwd: activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined,
            activeShell: activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined,
            onOpenFolder: openFavorite,
            hide: hideMenu,
          }),
        ],
      },
      { separator: true, label: "sep-actions" },
      {
        label: "Tema",
        icon: mode === "auto" ? Icons.themeAuto : mode === "light" ? Icons.sun : Icons.moon,
        submenu: (["auto", "light", "dark"] as ThemeMode[]).map((m) => ({
          label: themeModeLabels[m],
          icon: m === "auto" ? Icons.themeAuto : m === "light" ? Icons.sun : Icons.moon,
          checked: mode === m,
          onSelect: () => setMode(m),
        })),
      },
      { separator: true, label: "sep-theme" },
      { label: "Impostazioni", icon: Icons.settings, onSelect: openSettings },
    ];
  }

  return (
    <div className={`app-shell${isMaximized ? " maximized" : ""}${isEdgeFlush ? " edge-flush" : ""}`}>
      <header className="app-headerbar" data-tauri-drag-region>
        <button
          className="icon-button"
          onClick={() => setSidebarCollapsed((c) => !c)}
          onContextMenu={(e) =>
            openMenu(
              e,
              (
                [
                  ["auto", "Automatica (larghezza)"],
                  ["docked", "Fissato"],
                  ["floating", "Flottante"],
                ] as [SidebarMode, string][]
              ).map(([m, label]) => ({ label, checked: sidebarMode === m, onSelect: () => setSidebarMode(m) })),
            )
          }
          aria-label="Mostra/nascondi pannello laterale"
          title="Mostra/nascondi pannello laterale (click destro per la modalità)"
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
          onNew={(shellId) => addTab(undefined, shellId)}
          onRename={renameTab}
          onDuplicate={duplicateTab}
          onReorder={reorderTab}
          onDragOut={(id) => void handleTabDragOut(id)}
        />

        <div className="header-right">
          {quickActionIds.length > 0 && (
            <div className="quick-actions">
              {quickActionIds.map((id) => {
                const plugin = allPlugins.find((p) => p.id === id);
                if (!plugin) return null;
                return (
                  <div
                    key={id}
                    onContextMenu={(e) =>
                      openMenu(e, [{ label: "Rimuovi dagli shortcut", danger: true, onSelect: () => toggleQuickAction(id) }])
                    }
                  >
                    <PluginUsageButton plugin={plugin} icon={pluginIconNode(plugin)} onRun={() => runPlugin(plugin)} />
                  </div>
                );
              })}
            </div>
          )}
          {favoritesButtonVisible && (
            <FavoritesButton
              activeCwd={activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined}
              activeShell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
              onOpenFolder={openFavorite}
            />
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
                // The startup tab has no cwd until the start folder is
                // resolved (see above) - mounting it earlier would spawn its
                // shell in whatever directory the app itself started in.
                if (!tab.cwd) return null;
                return (
                  <TerminalView
                    key={tab.id}
                    tabId={tab.id}
                    ref={(handle) => {
                      if (handle) termRefs.current.set(tab.id, handle);
                      else termRefs.current.delete(tab.id);
                    }}
                    cwd={tab.cwd || undefined}
                    hidden={tab.id !== activeTabId}
                    onTitleChange={(title) => handleTitleChange(tab.id, title)}
                    onBusyChange={(busy) => handleBusyChange(tab.id, busy)}
                    onCommandLine={(line) => handleCommandLine(tab.id, line)}
                    runOnStart={pendingCommandsRef.current.get(tab.id)}
                    shellOverride={pendingShellOverrideRef.current.get(tab.id)}
                    restoredContent={restoredContentRef.current.get(tab.id)}
                    attach={pendingAttachRef.current.get(tab.id)}
                  />
                );
              }
              if (tab.kind === "editor") {
                return (
                  <Suspense key={tab.id} fallback={null}>
                    <EditorView
                      ref={(handle) => {
                        if (handle) editorRefs.current.set(tab.id, handle);
                        else editorRefs.current.delete(tab.id);
                      }}
                      path={tab.path}
                      hidden={tab.id !== activeTabId}
                      onDirtyChange={(dirty) => handleDirtyChange(tab.id, dirty)}
                      onRenamed={(newPath) => handleEditorRenamed(tab.id, newPath)}
                      initialContent={pendingEditorContentRef.current.get(tab.id)}
                    />
                  </Suspense>
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
                  favoritesButtonVisible={favoritesButtonVisible}
                  onSetFavoritesButtonVisible={setFavoritesButtonVisible}
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
              windowLabel={appWindow.label}
              tabs={tabs.filter((t): t is TermTab => t.kind === "terminal")}
              activeTabId={activeTabId}
              getPtyId={(tabId) => termRefs.current.get(tabId)?.getPtyId() ?? null}
              onOpenTab={selectTab}
              onOpenSession={openAgentSession}
              onClose={() => setAgentsSidebarOpen(false)}
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
      {!hasSeenWelcome() && (
        <Suspense fallback={null}>
          <WelcomeFlow />
        </Suspense>
      )}
      <TerminalSettingsProvider>
        <SettingsSectionProvider>
          <ConfirmDialogProvider>
            <UpdateProvider>
              <ContextMenuProvider>
                <Shell />
              </ContextMenuProvider>
            </UpdateProvider>
          </ConfirmDialogProvider>
        </SettingsSectionProvider>
      </TerminalSettingsProvider>
    </ThemeProvider>
  );
}
