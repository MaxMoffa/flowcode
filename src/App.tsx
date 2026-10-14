import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Sidebar } from "./sidebar/Sidebar";
import { isLikelyTextFile } from "./sidebar/fileIcons";
import { AgentsSidebar } from "./agents/AgentsSidebar";
import { TerminalView, type PromptAnchor, type TerminalHandle, type TerminalTransfer } from "./terminal/Terminal";
import { TabStrip } from "./terminal/TabStrip";
import { NarrowBottom, TabSwitcher } from "./app/NarrowChrome";
import { lastSubmitAt } from "./terminal/ptyClient";
import type { EditorHandle } from "./editor/EditorView";
import { SymbolOutline } from "./editor/SymbolOutline";
import type { AppTab, TermTab, EditorTab } from "./tabs/types";
import type { GitChange } from "./git/gitStatus";
import { ThemeProvider, useTheme, type ThemeMode } from "./themes/ThemeContext";
import { shellStartKey, TerminalSettingsProvider, useTerminalSettings } from "./terminal/TerminalSettingsContext";
import { loadSession, saveWindowSession, type SavedTab, type SavedWindow } from "./session/session";
import { UpdateProvider } from "./update/UpdateContext";
import {
  defaultWslDistro,
  resolveWslStartDir,
  sameShell,
  toWindowsPath,
  toWslPath,
  wslDistroOfPath,
  wslDistroOfShell,
  wslHomeDir,
  wslShellId,
} from "./terminal/wslPath";
import { useAutoResume } from "./agents/useAutoResume";
import { useAutoResumeSettings } from "./agents/autoResumeSettings";
import { useAgentNotifications } from "./notifications/useAgentNotifications";
import { watchLimitResets } from "./notifications/limitResetWatcher";
import { isPhoneAction, publishRemoteActions, watchUsageForRemote, type UsageWatch } from "./plugins/remotePublish";
import { useRemoteLeader } from "./remote/leader";
import { useNotificationSettings } from "./notifications/notificationSettings";
import { setActiveAgent } from "./agents/activeAgent";
import { tabAgentOf, useAgentSessions, type AgentSession, type TabAgent } from "./agents/agentSessions";
import { cliInstallCommand } from "./cli/cliInstallCommands";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider, useOpenContextMenu, useContextMenu, type ContextMenuItem } from "./context-menu/ContextMenuContext";
import { ConfirmDialogProvider, useConfirmDialog } from "./dialog/ConfirmDialogContext";
import { SettingsPage } from "./settings/SettingsPage";
import { ChangelogNav, ChangelogPage, ChangelogProvider, WhatsNewPage } from "./changelog/ChangelogPage";
import { consumeUpdatedVersion } from "./changelog/lastRunVersion";
import { SettingsNav } from "./settings/SettingsNav";
import { SettingsSectionProvider, useSettingsSection } from "./settings/SettingsSectionContext";
import { RemoteSettingsBridge } from "./remote/RemoteSettingsBridge";
import { RemotePairConfirm } from "./remote/RemotePairConfirm";
import { ShortcutsProvider } from "./shortcuts/ShortcutsContext";
import { MenuIcons } from "./context-menu/menuIcons";
import { ShortcutsDialog } from "./shortcuts/ShortcutsDialog";
import { PluginMenu } from "./plugins/PluginMenu";
import { PluginUsageButton } from "./plugins/PluginUsageButton";
import { PluginToast } from "./plugins/PluginToast";
import { PluginDialog } from "./plugins/PluginDialog";
import { builtinPlugins, examplePlugins, DEFAULT_QUICK_ACTIONS } from "./plugins/registry";
import { pluginIconNode } from "./plugins/icons";
import type { PluginDef, PluginManifest, PluginButtonDef } from "./plugins/types";
import { FavoritesButton, StarIcon, favoritesMenuItem } from "./favorites/FavoritesButton";
import type { FavoriteFolder } from "./favorites/favoritesStore";
import { hasSeenWelcome } from "./welcome/welcomeSeen";
import { useResizablePanelWidth } from "./hooks/useResizablePanelWidth";
import { usePanelPresence } from "./hooks/usePanelPresence";
import { SIDEBAR_MODES, EXPLORER_LINK_MODES, type SidebarMode, type ExplorerLinkMode } from "./settings/modes";
import { readBool, readEnum, readJson, readString, removeKey, usePersistentState, writeBool, writeJson, writeString } from "./lib/storage";
import { basename, expandHome, isAbsolutePath, isWindowsHostPath, isWindowsPlatform } from "./lib/path";
import { withCodexLaunchFlags } from "./plugins/codexLaunch";
import { atShellPrompt, cdCommand, ptyForeground, type Foreground } from "./terminal/shellDialect";
import { useI18n } from "./i18n";
import { NewTabPage, type NewTabLaunch } from "./newtab/NewTabPage";
import { recordRecentTerminal } from "./newtab/recentTerminals";
import { recordCommand } from "./newtab/commandHistory";
import { profileForPath, refreshProfiles, useProfiles } from "./profiles/profiles";
import { ProfilePicker } from "./profiles/ProfilePicker";
import { activeTabProfile } from "./profiles/activeTabProfile";
import { Icons } from "./app/icons";
import { useWindowChrome } from "./window/useWindowChrome";
import { ZoomRow } from "./terminal/ZoomRow";
import {
  TITLE_HOST_PREFIX,
  cleanTitle,
  cmdTitlePathCandidates,
  firstExistingDir,
  labelForCwd,
  looksLikeExecutablePath,
} from "./terminal/tabTitle";
import { takeWindowInit, tabStripDropIndex, type CursorTarget, type TabTransfer } from "./tabs/transfer";
import { newTabId } from "./tabs/tabId";
import { makeTermTab, patchTermTab } from "./tabs/tabState";
import "./App.css";
import { AGENT_CLIS, CLI_INFO, cliOfPlugin, type AgentCli } from "./agents/cliInfo";

const appWindow = getCurrentWindow();
/** The window Flowcode starts with - the one that restores the saved session
 * and checks for updates. Every other window was opened from it (a tab
 * dragged out, or a restored extra window). */
const isMainWindow = appWindow.label === "main";

/** What a terminal reports to the New Tab page turning into it: where its
 * prompt will land, and (`null`: never) where it did. */
interface Handoff {
  anchor?: PromptAnchor;
  promptShown?: PromptAnchor | null;
}

// Loaded on demand: CodeMirror (every language grammar) and the flowkit
// onboarding flow are the bulk of the bundle, and plenty of sessions never
// open a file - the welcome flow only ever shows on first launch.
const DiffView = lazy(() => import("./git/DiffView").then((m) => ({ default: m.DiffView })));
const EditorView = lazy(() => import("./editor/EditorView").then((m) => ({ default: m.EditorView })));
const WelcomeFlow = lazy(() => import("./welcome/WelcomeFlow").then((m) => ({ default: m.WelcomeFlow })));

const SIDEBAR_MODE_KEY = "flowcode.sidebarMode";
const EXPLORER_LINK_MODE_KEY = "flowcode.explorerLinkMode";
// Below this window width, "auto" mode floats the explorer instead of
// docking it, so a narrow window keeps its terminal usable.
const SIDEBAR_AUTO_BREAKPOINT = 880;
// Below this the layout switches to its phone-like form (two-row header,
// side panels as overlays). Mirrored by the `.is-narrow` rules in App.css.
const NARROW_BREAKPOINT = 640;

const QUICK_ACTIONS_KEY = "flowcode.quickActions";
const PLUGINS_SEEDED_KEY = "flowcode.pluginsSeeded";
const PLUGINS_MIGRATED_KEY = "flowcode.pluginsActionMigrated";
/** Set once the Mistral Vibe plugin, shipped after the others, has been
 * offered to an install that had already seeded them. */
const VIBE_PLUGIN_SEEDED_KEY = "flowcode.vibePluginSeeded";

/** Plugin commands the user has OK'd: `<plugin id>:<hash of the command>`
 * entries, so editing a plugin's command asks again. */
const PLUGIN_APPROVALS_KEY = "flowcode.pluginApprovals";
const FAVORITES_BUTTON_VISIBLE_KEY = "flowcode.favoritesButtonVisible";
const SIDEBAR_COLLAPSED_KEY = "flowcode.sidebarCollapsed";
const AGENTS_SIDEBAR_OPEN_KEY = "flowcode.agentsSidebarOpen";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
/** Not a security boundary, just a compact stable stamp of a command's text. */
function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}
const readQuickActions = (key: string) => readJson(key, isStringArray, DEFAULT_QUICK_ACTIONS);
const readTrue = (key: string) => readBool(key, true);
const readFalse = (key: string) => readBool(key, false);
const readSidebarMode = (key: string) => readEnum(key, SIDEBAR_MODES, "auto");
const readLinkMode = (key: string) => readEnum(key, EXPLORER_LINK_MODES, "auto");

function Shell() {
  // All persisted across restarts - every toggle path (header button,
  // shortcut, floating backdrop, the agents panel's own X, Settings...) goes
  // through these setters, so persisting in one place covers all of them.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(SIDEBAR_COLLAPSED_KEY, readFalse, writeBool);
  const [agentsSidebarOpen, setAgentsSidebarOpen] = usePersistentState(AGENTS_SIDEBAR_OPEN_KEY, readFalse, writeBool);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const { setSection: setSettingsSection } = useSettingsSection();
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
  const [tabs, setTabs] = useState<AppTab[]>([makeTermTab("tab-0", "")]);
  const [activeTabId, setActiveTabId] = useState("tab-0");
  const [activeTerminalId, setActiveTerminalId] = useState("tab-0");
  const latestRef = useRef({ tabs, activeTabId, activeTerminalId });
  // What the periodic session save looks at: tabs or the active tab changed,
  // or a busy/command-line event, since the last save (see `persist`).
  const sessionDirtyRef = useRef(true);
  if (latestRef.current.tabs !== tabs || latestRef.current.activeTabId !== activeTabId) sessionDirtyRef.current = true;
  latestRef.current = { tabs, activeTabId, activeTerminalId };
  const { isMaximized, isEdgeFlush, isFullscreen, toggleFullscreen } = useWindowChrome();
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
  // A command to leave typed (not run) on a tab's first prompt - a recent
  // terminal reopened from the new tab page. Same lifecycle as the two above.
  const pendingTypedCommandsRef = useRef(new Map<string, string>());
  // Tabs whose start folder is still being looked up - see `fillStartDir`.
  const startDirPendingRef = useRef(new Set<string>());
  // The shell last picked on each new tab page - see `previewNewTabShell`.
  const newTabShellRef = useRef(new Map<string, string>());
  // Tabs whose profile was chosen on purpose (a menu row, the new tab page's
  // chips, a duplicate, an agent launch...): the automatic pick - the folder's
  // project default, else the profile of the tab that was active - never
  // overwrites them. See `addTab` / `fillStartDir`.
  const explicitProfileRef = useRef(new Set<string>());
  // The profile of the tab that was active when a tab was created: what an
  // automatic tab falls back to when its folder has no project default.
  const inheritedProfileRef = useRef(new Map<string, string | undefined>());
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const { profiles } = useProfiles();
  const editorRefs = useRef(new Map<string, EditorHandle>());
  // A terminal session moved here from another window, keyed by its new tab
  // id - handed to that tab's TerminalView once, at mount (its `attach`).
  const pendingAttachRef = useRef(new Map<string, TerminalTransfer>());
  // Same for an editor tab moved here with unsaved edits.
  const pendingEditorContentRef = useRef(new Map<string, string>());
  const pluginBtnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmDialog();
  const { t, language } = useI18n();
  const openMenu = useOpenContextMenu();
  const { show: showMenu, hide: hideMenu } = useContextMenu();
  const { mode, toggleTheme, setMode } = useTheme();
  const notificationSettings = useNotificationSettings();
  const autoResumeEnabled = useAutoResumeSettings().enabled;
  const { sessions: agentSessions, refresh: refreshAgentSessions } = useAgentSessions(
    Object.values(notificationSettings).some(Boolean) || autoResumeEnabled,
  );
  const {
    startPath,
    shellStartPaths,
    resetTabZoom,
    zoomTabIn,
    zoomTabOut,
    restoreSession,
    shellId,
    newTabPage,
    tabFontSizeOverrides,
    setTabFontSize,
    getTabFontSize,
  } = useTerminalSettings();
  // Tabs whose new tab page is still fading out over the terminal that just
  // replaced it (see NewTabPage's `onLaunch`/`onDone`).
  // The value is whether that tab's terminal has reported ready.
  const [handoffs, setHandoffs] = useState<Map<string, Handoff>>(() => new Map());
  const patchHandoff = (tabId: string, patch: Handoff) =>
    setHandoffs((prev) => (prev.has(tabId) ? new Map(prev).set(tabId, { ...prev.get(tabId), ...patch }) : prev));
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
   * click, with account status moved to the hover popover instead.
   * An install seeded before Mistral Vibe shipped gets its plugin added once
   * too - listed in the plugin menu, not pinned to a bar the user arranged. */
  async function seedExamplePlugins() {
    const seededBefore = !!readString(PLUGINS_SEEDED_KEY);
    try {
      const existing = await invoke<PluginManifest[]>("list_plugins");
      const byId = new Map(existing.map((p) => [p.id, p]));

      if (!readString(PLUGINS_MIGRATED_KEY)) {
        const migratedIds: string[] = [];
        for (const manifest of examplePlugins()) {
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
        for (const manifest of examplePlugins()) {
          if (!chosen.includes(manifest.id)) continue;
          if (!byId.has(manifest.id)) await invoke("save_plugin", { plugin: manifest });
          chosenIds.push(manifest.id);
        }
        pinToQuickActions(chosenIds);
        writeString(PLUGINS_SEEDED_KEY, "1");
      }

      if (!readString(PLUGINS_SEEDED_KEY)) {
        const newIds: string[] = [];
        for (const manifest of examplePlugins()) {
          if (!byId.has(manifest.id)) {
            await invoke("save_plugin", { plugin: manifest });
            newIds.push(manifest.id);
          }
        }
        pinToQuickActions(newIds);
      } else if (seededBefore && !chosen && !readString(VIBE_PLUGIN_SEEDED_KEY) && !byId.has(CLI_INFO.vibe.pluginId)) {
        const vibe = examplePlugins().find((p) => p.id === CLI_INFO.vibe.pluginId);
        if (vibe) await invoke("save_plugin", { plugin: vibe });
      }
    } catch {
      /* plugins folder unavailable (e.g. dev in a plain browser) */
    }
    writeString(PLUGINS_MIGRATED_KEY, "1");
    writeString(PLUGINS_SEEDED_KEY, "1");
    writeString(VIBE_PLUGIN_SEEDED_KEY, "1");
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
      window.alert(t("plugins.saveFailed", { error: String(e) }));
    }
  }

  async function deletePlugin(id: string) {
    try {
      await invoke("delete_plugin", { id });
      await reloadCustomPlugins();
      setQuickActionIds((prev) => prev.filter((x) => x !== id));
    } catch (e) {
      window.alert(t("plugins.deleteFailed", { error: String(e) }));
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
      const settingsLabel = t("settings.title");
      const changelogLabel = t("changelog.title");
      const whatsNewLabel = t("whatsNew.title");
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
          const id = newTabId("tab");
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
            notifyMuted: t.notifyMuted,
            nestedShell: wslDistro !== undefined ? "wsl" : undefined,
            wslDistro: wslDistro ?? undefined,
            profileId: t.profileId,
          });
        } else if (t.kind === "editor") {
          restored.push({ kind: "editor", id: newTabId("editor"), path: t.path, label: t.label });
        } else if (t.kind === "whatsNew") {
          if (!restored.some((r) => r.kind === "whatsNew")) {
            restored.push({ kind: "whatsNew", id: "whatsnew", label: whatsNewLabel, version: t.version });
          }
        } else if (t.kind === "changelog") {
          if (!restored.some((r) => r.kind === "changelog")) {
            restored.push({ kind: "changelog", id: "changelog", label: changelogLabel });
          }
        } else if (!restored.some((r) => r.kind === "settings")) {
          restored.push({ kind: "settings", id: "settings", label: settingsLabel });
        }
      }
      if (cancelled) return;
      if (!restored.some((r) => r.kind === "terminal")) {
        restored.unshift(makeTermTab("tab-0", ""));
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
        // A diff is a view of the repository current state: nothing to restore.
        if (t.kind === "diff") return false;
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
              notifyMuted: t.notifyMuted,
              shell: tabShell(t),
              profileId: t.profileId,
              content: term?.wasUsed() ? term.serialize() : restoredContentRef.current.get(t.id),
            };
          }
          if (t.kind === "editor") return { kind: "editor", path: t.path, label: t.label };
          if (t.kind === "changelog") return { kind: "changelog" };
          if (t.kind === "whatsNew") return { kind: "whatsNew", version: t.version };
          return { kind: "settings" };
        }),
      };
    }
    // Setting off: overwrite with an empty session rather than leave a stale
    // one around for whenever it's switched back on. Each window reports
    // only its own part; the backend writes the file (see session.rs).
    // The periodic save is skipped while nothing changed since the last one
    // that went through; a close or a flush request always writes.
    let lastSaved: string | null = null;
    const persist = async (flushGen?: number, periodic = false) => {
      // Nothing to look at while the window is hidden, nothing changed and no
      // agent is printing: skip the serialize of every terminal.
      const anyTabBusy = latestRef.current.tabs.some((t) => t.kind === "terminal" && t.busy);
      if (periodic && document.hidden && !sessionDirtyRef.current && !anyTabBusy) return;
      sessionDirtyRef.current = false;
      const snap = restoreSessionRef.current ? await snapshot() : null;
      const json = JSON.stringify(snap);
      if (periodic && json === lastSaved) return;
      const saved = await saveWindowSession(snap, flushGen).then(
        () => true,
        () => false,
      );
      if (saved) lastSaved = json;
    };
    // Right away too, so a freshly opened window is part of the session
    // from the start.
    void persist();
    // Periodic too, not just on close - a crash or a killed process never
    // gets a close event.
    const timer = setInterval(() => void persist(undefined, true), 15000);
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
    // Every tab still without a folder (the startup one, a restored one
    // whose folder is gone) gets its shell's start folder - see
    // `fillStartDir`.
    for (const t of latestRef.current.tabs) {
      if (t.kind !== "terminal" || t.cwd !== "") continue;
      // A tab that didn't come from `addTab` (restored from the last session)
      // keeps the profile it had, even the default one.
      if (!inheritedProfileRef.current.has(t.id)) explicitProfileRef.current.add(t.id);
      fillStartDir(t.id, pendingShellOverrideRef.current.get(t.id) ?? shellId);
    }
  }, [homeDir, resolvedStartPath, startPathChecked, sessionChecked]);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    seedExamplePlugins().then(reloadCustomPlugins);
    // Per-plugin usage profiles used to be remembered here; now they follow
    // the active tab's profile, so the old keys are dead weight.
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("flowcode.usageProfile.")) removeKey(key);
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    },
    [],
  );

  const isNarrow = windowWidth < NARROW_BREAKPOINT;
  // Narrow windows have no room to dock a panel next to the terminal, so the
  // sidebar floats whatever its configured mode.
  const effectiveSidebarMode: "docked" | "floating" = isNarrow
    ? "floating"
    : sidebarMode === "auto"
      ? windowWidth < SIDEBAR_AUTO_BREAKPOINT
        ? "floating"
        : "docked"
      : sidebarMode;
  // Kept mounted a beat after closing so the docked panels can animate out.
  const sidebarDocked = effectiveSidebarMode === "docked" && !sidebarCollapsed;
  const sidebarPresence = usePanelPresence(sidebarDocked);
  const agentsPresence = usePanelPresence(agentsSidebarOpen);

  // The usage popover's "Sign in" button: a window event, since the popover
  // is portaled far from App. Only the known login commands are honoured.
  const openLoginRef = useRef(openTerminalWithCommand);
  openLoginRef.current = openTerminalWithCommand;
  useEffect(() => {
    const onCliLogin = (e: Event) => {
      const { command, profile } = (e as CustomEvent<{ command?: string; profile?: string }>).detail ?? {};
      if (!command || !Object.values(CLI_INFO).some((c) => c.loginCommand === command)) return;
      openLoginRef.current(command, profile);
    };
    window.addEventListener("flowcode:cli-login", onCliLogin);
    return () => window.removeEventListener("flowcode:cli-login", onCliLogin);
  }, []);

  // Both panels are overlays when narrow, so only one may be open: whichever
  // was opened last wins (on entering narrow with both open, the sidebar wins).
  const prevPanelsRef = useRef({ sidebarOpen: !sidebarCollapsed, agentsOpen: agentsSidebarOpen });
  useEffect(() => {
    const prev = prevPanelsRef.current;
    const sidebarOpen = !sidebarCollapsed;
    prevPanelsRef.current = { sidebarOpen, agentsOpen: agentsSidebarOpen };
    if (!isNarrow || !sidebarOpen || !agentsSidebarOpen) return;
    if (!prev.agentsOpen) setSidebarCollapsed(true);
    else setAgentsSidebarOpen(false);
  }, [isNarrow, sidebarCollapsed, agentsSidebarOpen, setSidebarCollapsed, setAgentsSidebarOpen]);

  useEffect(() => {
    if (!isNarrow || !agentsSidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAgentsSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, agentsSidebarOpen, setAgentsSidebarOpen]);

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
    clearTerminal: () => activeTermHandle()?.clear(),
    copy: () => activeTermHandle()?.copySelection(),
    paste: () => activeTermHandle()?.paste(),
    newTab: () => openNewTab(),
    // Without any profile there is nothing to pick: same as a plain new tab.
    newTabWithProfile: () => (profiles.length > 0 ? setProfilePickerOpen(true) : openNewTab()),
    closeTab: () => closeTab(activeTabId),
    toggleTheme: () => toggleTheme(),
    duplicateTab: () => duplicateTab(activeTabId),
    nextTab: () => stepTab(1),
    prevTab: () => stepTab(-1),
    moveTabLeft: () => moveActiveTab(-1),
    moveTabRight: () => moveActiveTab(1),
    selectTab1: () => selectTabAt(0),
    selectTab2: () => selectTabAt(1),
    selectTab3: () => selectTabAt(2),
    selectTab4: () => selectTabAt(3),
    selectTab5: () => selectTabAt(4),
    selectTab6: () => selectTabAt(5),
    selectTab7: () => selectTabAt(6),
    selectTab8: () => selectTabAt(7),
    lastTab: () => selectTabAt(tabs.length - 1),
    zoomIn: () => activeTermHandle() && zoomTabIn(activeTerminalId),
    zoomOut: () => activeTermHandle() && zoomTabOut(activeTerminalId),
    resetZoom: () => activeTermHandle() && resetTabZoom(activeTerminalId),
    toggleAgents: () => setAgentsSidebarOpen((o) => !o),
    openSettings: () => openSettings(),
    showShortcuts: () => setShortcutsDialogOpen((o) => !o),
  });

  /** Ctrl+Tab / Ctrl+Shift+Tab: the next/previous tab in strip order,
   * wrapping around at the ends. */
  function stepTab(delta: number) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    selectTab(tabs[(i + delta + tabs.length) % tabs.length].id);
  }

  /** Ctrl+1..9: the tab at that position - out of range does nothing. */
  function selectTabAt(index: number) {
    const tab = tabs[index];
    if (tab) selectTab(tab.id);
  }

  function moveActiveTab(delta: number) {
    const i = tabs.findIndex((t) => t.id === activeTabId);
    const to = i + delta;
    if (i !== -1 && to >= 0 && to < tabs.length) reorderTab(activeTabId, to);
  }

  function selectTab(id: string) {
    setActiveTabId(id);
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    if (tab?.kind === "terminal") setActiveTerminalId(id);
  }
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  // The phone-triggered action runner and what it needs, kept current each
  // render for the long-lived "remote://run-action" listener.
  const remoteActionRef = useRef<(id: string, ptyId: string | null) => void>(() => {});
  /** The phone asked to sign a CLI in under a profile (see loginProfile). */
  const remoteProfileLoginRef = useRef<(profileId: string, cli: string) => void>(() => {});
  const remoteLoginTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(remoteLoginTimerRef.current), []);
  const runPluginRef = useRef<(plugin: PluginDef) => void>(() => {});
  const allPluginsRef = useRef<PluginDef[]>([]);

  /** A new tab showing the new tab page (see src/newtab) instead of
   * starting the default shell straight away - what "+", Ctrl+T and "Nuovo
   * terminale" open. With the page turned off in Settings it is the default
   * shell straight away, like the tab strip's per-shell menu entries. */
  function openNewTab(): string {
    return newTabPage ? addTab(undefined, undefined, true) : addTab();
  }

  /** `profileId`: `undefined` = automatic (the folder's project default
   * profile, else the active terminal's), `null` = the default profile on
   * purpose, a string = that profile on purpose. */
  function addTab(cwdOverride?: string, shellOverride?: string, newTab = false, profileId?: string | null): string {
    // No longer inherits the active tab's cwd - a fresh tab starts in its
    // shell's start folder (Impostazioni > Cartella di avvio, per shell or
    // the general one), looked up by `fillStartDir` below. `cwdOverride` is
    // still how a caller that *does* want a specific folder (duplicateTab,
    // opening a favorite, resuming an agent session) gets one.
    const id = newTabId("tab");
    // A `\\wsl.localhost\<distro>\...` folder only a WSL shell can start in,
    // whatever the caller (or the configured default) would have picked.
    const pathDistro = cwdOverride ? wslDistroOfPath(cwdOverride) : null;
    if (pathDistro && wslDistroOfShell(shellOverride ?? shellId) === undefined) shellOverride = wslShellId(pathDistro);
    if (shellOverride) pendingShellOverrideRef.current.set(id, shellOverride);
    // A tab whose shell *is* wsl.exe from the moment it spawns never goes
    // through the "user typed `wsl`" detection in handleCommandLine below -
    // there's no host shell first for them to type into - so without this
    // its first WSL prompt's title update is read as a plain host path
    // (nestedShell undefined) and the explorer just never follows it in.
    const wslDistro = wslDistroOfShell(shellOverride ?? shellId);
    const nestedShell = wslDistro !== undefined ? "wsl" : undefined;
    // Env vars don't reach a WSL distro, so a profile means nothing there.
    const canProfile = wslDistro === undefined && !pathDistro;
    const explicit = profileId !== undefined;
    if (explicit) explicitProfileRef.current.add(id);
    const { tabs: openTabs, activeTerminalId: activeId } = latestRef.current;
    inheritedProfileRef.current.set(
      id,
      openTabs.find((t): t is TermTab => t.id === activeId && t.kind === "terminal")?.profileId,
    );
    // Without a folder to open in, left unmounted (empty cwd) until
    // `fillStartDir` has resolved one. An automatic profile needs the
    // folder too (its project default) and a shell's env is fixed at spawn,
    // so such a tab waits for it even when the caller already knows the folder.
    const auto = !explicit && canProfile;
    const cwd = auto || newTab ? "" : (cwdOverride ?? "");
    setTabs((prev) => [
      ...prev,
      {
        kind: "terminal",
        id,
        cwd,
        explorerPath: cwd,
        label: newTab ? t("newTab.title") : labelForCwd(cwdOverride ?? ""),
        nestedShell,
        wslDistro: pathDistro ?? wslDistro ?? undefined,
        ...(typeof profileId === "string" && canProfile ? { profileId } : {}),
        ...(newTab ? { newTab } : {}),
      },
    ]);
    if (!cwd) fillStartDir(id, shellOverride ?? shellId, cwdOverride);
    setActiveTabId(id);
    setActiveTerminalId(id);
    return id;
  }

  /** The folder a fresh tab of `shell` starts in: that shell's own start
   * folder if one is set (Impostazioni > Cartella di avvio per shell) and
   * still exists, the general start folder otherwise (itself falling back
   * to the user's home). Except WSL, whose default is the distro's home -
   * the same place `wsl` drops you with a bare `cd`. Starting it in the
   * general start folder instead meant `/mnt/c/...`, which the explorer
   * shows as a plain `C:\...` path: it follows the session fine, but going
   * up stops at `C:\` - the explorer is browsing Windows, not the distro,
   * and never reaches the Linux tree the shell lives in. From the home,
   * going up walks the distro's own tree (`\\wsl.localhost\<distro>` is
   * `/`), in step with the shell. A general start folder that's already
   * inside a distro is kept as is. */
  async function resolveStartDir(shell: string): Promise<string> {
    const fallback = resolvedStartPath || homeDir;
    const custom = shellStartPaths[shellStartKey(shell)] ?? "";
    const distro = wslDistroOfShell(shell);
    if (distro !== undefined) {
      if (!custom && wslDistroOfPath(fallback)) return fallback;
      return (await resolveWslStartDir(distro, custom || "~")) ?? fallback;
    }
    if (custom && (await invoke<boolean>("is_directory", { path: custom }).catch(() => false))) return custom;
    return fallback;
  }

  /** The profile a not-yet-spawned tab should run under when nobody chose one
   * for it: `cwd`'s project default, else the one inherited from the tab that
   * was active at creation. `undefined` for a tab with an explicit profile
   * (left alone) or a WSL one (env vars can't reach the distro). */
  async function automaticProfile(tabId: string, cwd: string, wsl: boolean): Promise<string | undefined> {
    if (wsl || explicitProfileRef.current.has(tabId)) return undefined;
    return (await profileForPath(cwd)) ?? inheritedProfileRef.current.get(tabId);
  }

  /** Gives a tab still without a folder its shell's start folder (see
   * `resolveStartDir`) - or `knownCwd` when the caller already has one - and,
   * unless its profile was chosen on purpose, its automatic profile (see
   * `automaticProfile`). The tab isn't mounted until then, so its shell
   * can still be switched: a start folder inside a distro only a WSL shell
   * can open. */
  function fillStartDir(tabId: string, shell: string, knownCwd?: string) {
    if (startDirPendingRef.current.has(tabId)) return;
    startDirPendingRef.current.add(tabId);
    void (async () => {
      const cwd = knownCwd ?? (await resolveStartDir(shell));
      const pathDistro = wslDistroOfPath(cwd);
      const wslShell = wslDistroOfShell(shell) !== undefined;
      const profile = await automaticProfile(tabId, cwd, !!pathDistro || wslShell);
      startDirPendingRef.current.delete(tabId);
      if (pathDistro && !wslShell) pendingShellOverrideRef.current.set(tabId, wslShellId(pathDistro));
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) =>
          t.cwd
            ? null
            : {
                cwd,
                explorerPath: cwd,
                // A restored tab whose folder is gone still keeps the name
                // the user gave it.
                label: t.customLabel || t.newTab ? t.label : labelForCwd(cwd),
                nestedShell: pathDistro || wslShell ? "wsl" : t.nestedShell,
                wslDistro: pathDistro ?? t.wslDistro,
                // A restored tab keeps the profile it had; a pick made while
                // the folder was being looked up wins over the automatic one.
                profileId: t.profileId ?? (explicitProfileRef.current.has(tabId) ? undefined : profile),
              },
        ),
      );
    })();
  }

  /** The new tab page's shell selection changed: point the tab's folder
   * (the explorer, the page's prompt) at that shell's own start folder. */
  function previewNewTabShell(tabId: string, shell: string | undefined) {
    const target = shell ?? shellId;
    newTabShellRef.current.set(tabId, target);
    void resolveStartDir(target).then(async (cwd) => {
      const wsl = wslDistroOfShell(target) !== undefined || !!wslDistroOfPath(cwd);
      // The folder may carry a different project default profile.
      const profile = await automaticProfile(tabId, cwd, wsl);
      if (newTabShellRef.current.get(tabId) !== target) return;
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) => {
          if (!t.newTab) return null;
          const nextProfile = explicitProfileRef.current.has(tabId) ? t.profileId : profile;
          return { cwd, explorerPath: cwd, profileId: nextProfile };
        }),
      );
    });
  }

  /** Turns a tab still on the new tab page into a terminal: `shell`
   * (default: the configured one) started in `cwd` (default: that shell's
   * start folder), running `command` - or with it just typed, for
   * `typeOnly`. */
  function launchFromNewTab(tabId: string, { shell, cwd, command, typeOnly }: NewTabLaunch) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab?.newTab) return;
    // The page's own cwd follows the chosen shell's start folder and
    // whatever the explorer browsed to (see `previewNewTabShell`, `browseExplorer`).
    const nextCwd = cwd ?? tab.cwd;
    const pathDistro = nextCwd ? wslDistroOfPath(nextCwd) : null;
    if (pathDistro && wslDistroOfShell(shell ?? shellId) === undefined) shell = wslShellId(pathDistro);
    if (shell) pendingShellOverrideRef.current.set(tabId, shell);
    if (command) (typeOnly ? pendingTypedCommandsRef : pendingCommandsRef).current.set(tabId, command);
    const wslDistro = wslDistroOfShell(shell ?? shellId);
    const wsl = !!pathDistro || wslDistro !== undefined;
    // A folder other than the one the page showed (a recent terminal, a
    // favorite) may have its own project default profile, and the shell can't
    // be spawned before that is known.
    const lookup = !wsl && !!cwd && cwd !== tab.cwd && !explicitProfileRef.current.has(tabId);
    void (async () => {
      const profile = lookup ? await automaticProfile(tabId, nextCwd, false) : undefined;
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) => ({
          newTab: undefined,
          cwd: nextCwd,
          explorerPath: nextCwd,
          label: t.customLabel ? t.label : labelForCwd(nextCwd),
          nestedShell: wsl ? "wsl" : undefined,
          wslDistro: pathDistro ?? wslDistro ?? undefined,
          // Env vars don't reach a WSL distro: its profile is dropped.
          profileId: wsl ? undefined : lookup && !explicitProfileRef.current.has(tabId) ? profile : t.profileId,
        })),
      );
      if (!nextCwd) fillStartDir(tabId, shell ?? shellId);
    })();
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
  function openTerminalWithCommand(command: string, profileId?: string) {
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, makeTermTab(id, homeDir, { label: "setup", profileId })]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** Opens a fresh terminal tab in `cwd`, resuming a specific agent session
   * the moment its shell is ready - used from the Agents sidebar for a
   * background/saved session (one this app has no open tab for), so
   * double-clicking it drops the user straight back into that chat instead
   * of a bare shell they'd have to resume by hand. */
  async function openAgentSession(cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string) {
    if (wslDistro) {
      // Saved inside WSL: resumed by the distro's own CLI, in a WSL tab
      // opened on that folder (`cwd` is a Linux path there). The
      // `--no-daemon` check is about Windows' Job Object - not WSL's concern.
      const command =
        cli === "claude"
          ? `claude --resume ${sessionId}`
          : cli === "vibe"
            ? `vibe --resume ${sessionId}`
            : `codex resume ${sessionId}`;
      const id = addTab(toWindowsPath(wslDistro, cwd), wslShellId(wslDistro));
      pendingCommandsRef.current.set(id, command);
      return;
    }
    const command =
      cli === "claude"
        ? `claude --resume ${sessionId}`
        : cli === "vibe"
          ? `vibe --resume ${sessionId}`
          : await withCodexLaunchFlags(`codex resume ${sessionId}`);
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, makeTermTab(id, cwd, { profileId })]);
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
    if (activeTerminal?.newTab && activeTabId === activeTerminal.id) {
      launchFromNewTab(activeTerminal.id, { shell, cwd: fav.path });
      return;
    }
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
      addTab(tab.cwd, tabShell(tab), false, tab.profileId ?? null);
      return;
    }
    if (tab.kind === "editor") {
      const newId = newTabId("editor");
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
        showPluginToast(t("app.openFailed", { name, error: String(e) })),
      );
      return;
    }
    const existing = latestRef.current.tabs.find((t) => t.kind === "editor" && t.path === path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    // Two opens before the next render both miss `existing`: they share one
    // id, and the updater drops the second add.
    const id = reservedTabId(`editor:${path}`, "editor");
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { kind: "editor", id, path, label: name }]));
    setActiveTabId(id);
  }

  /** Opens (or focuses) the diff of one file from the Git tab. */
  function openDiff(root: string, change: GitChange, staged: boolean) {
    const existing = latestRef.current.tabs.find(
      (t) => t.kind === "diff" && t.root === root && t.path === change.path && t.staged === staged,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const name = basename(change.path);
    const id = reservedTabId(`diff:${root}\u0000${change.path}\u0000${staged}`, "diff");
    const label = t(staged ? "git.stagedLabel" : "git.diffLabel", { name });
    setTabs((prev) =>
      prev.some((t) => t.id === id) ? prev : [...prev, { kind: "diff", id, root, path: change.path, staged, label }],
    );
    setActiveTabId(id);
  }

  /** The id a "open or focus" action uses for the tab it is about to add.
   * Two calls before the next render can't see each other's tab yet; handing
   * both the same id lets the `setTabs` updater tell the second is a repeat. */
  const reservedIdsRef = useRef(new Map<string, string>());
  function reservedTabId(key: string, kind: "editor" | "diff"): string {
    let id = reservedIdsRef.current.get(key);
    if (!id) {
      id = newTabId(kind);
      reservedIdsRef.current.set(key, id);
    }
    return id;
  }

  /** Opens `tab`, or focuses the one of its kind already open (`replace`:
   * swaps that one for `tab` instead). The check is inside the updater so
   * two quick calls can't add it twice. Also shows the side panel even if it
   * was collapsed: each of these pages keeps its navigation there. */
  function openSingleton(tab: Extract<AppTab, { kind: "settings" | "changelog" | "whatsNew" }>, replace = false) {
    setSidebarCollapsed(false);
    setTabs((prev) =>
      prev.some((p) => p.kind === tab.kind)
        ? replace
          ? prev.map((p) => (p.kind === tab.kind ? tab : p))
          : prev
        : [...prev, tab],
    );
    setActiveTabId(tab.id);
  }

  function openSettings() {
    openSingleton({ kind: "settings", id: "settings", label: t("settings.title") });
  }

  function openChangelog() {
    openSingleton({ kind: "changelog", id: "changelog", label: t("changelog.title") });
  }

  /** The "What's new" tab for `version` - replacing one already open (a
   * restored session can bring back the previous update's). */
  function openWhatsNew(version: string) {
    openSingleton({ kind: "whatsNew", id: "whatsnew", label: t("whatsNew.title"), version }, true);
  }

  // First launch after an update: show what it brought. Main window only,
  // once the restored session is in place so the tab lands after it.
  useEffect(() => {
    if (!isMainWindow || !sessionChecked) return;
    getVersion()
      .then((version) => {
        if (consumeUpdatedVersion(version)) openWhatsNew(version);
      })
      .catch(() => {});
  }, [sessionChecked]);

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
      const id = newTabId("tab");
      if (transfer.terminal) {
        pendingAttachRef.current.set(id, { ptyId: transfer.terminal.ptyId, snapshot: transfer.terminal.snapshot });
        if (transfer.terminal.shell) pendingShellOverrideRef.current.set(id, transfer.terminal.shell);
        if (transfer.terminal.fontSize !== undefined) setTabFontSize(id, transfer.terminal.fontSize);
      }
      adopted = { ...tab, id };
    } else if (tab.kind === "editor") {
      const id = newTabId("editor");
      if (transfer.editor?.dirty) pendingEditorContentRef.current.set(id, transfer.editor.content);
      adopted = { ...tab, id };
    } else if (tab.kind === "diff") {
      adopted = { ...tab, id: newTabId("diff") };
    } else if (tab.kind === "changelog") {
      adopted = { kind: "changelog", id: "changelog", label: t("changelog.title") };
    } else if (tab.kind === "whatsNew") {
      adopted = { ...tab, id: "whatsnew" };
    } else {
      adopted = { kind: "settings", id: "settings", label: t("settings.title") };
    }

    if (replaceAll) {
      // A window always has a terminal: one opened for an editor/settings
      // tab keeps its startup terminal next to it.
      setTabs((prev) => (adopted.kind === "terminal" ? [adopted] : [...prev.filter((t) => t.kind === "terminal"), adopted]));
    } else if (
      (adopted.kind === "settings" || adopted.kind === "changelog" || adopted.kind === "whatsNew") &&
      latestRef.current.tabs.some((t) => t.kind === adopted.kind)
    ) {
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
  // Keyed on what is reported, not on `tabs`: a title event that changes
  // nothing the backend shows shouldn't cost an IPC call.
  // Bumped when a terminal learns its pty id: the tab-to-agent match and the
  // tab report both depend on it, and neither is otherwise re-run for it.
  const [ptyVersion, setPtyVersion] = useState(0);
  const reportedTabsKey = tabs
    .filter((t): t is TermTab => t.kind === "terminal")
    .map((t) => `${t.id}\u0000${t.label}\u0000${t.cwd}`)
    .join("\u0001");
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const report = () => {
      const reported = latestRef.current.tabs
        .filter((t): t is TermTab => t.kind === "terminal")
        .map((t) => ({ pty_id: termRefs.current.get(t.id)?.getPtyId() ?? null, tab_id: t.id, label: t.label, cwd: t.cwd }));
      invoke("window_report_tabs", { tabs: reported }).catch(() => {});
      // Retried only while some tab's shell hasn't spawned yet.
      if (timer !== undefined && reported.every((r) => r.pty_id !== null)) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    report();
    timer = setInterval(report, 3000);
    return () => clearInterval(timer);
  }, [reportedTabsKey, ptyVersion]);

  const adoptTabRef = useRef(adoptTab);
  adoptTabRef.current = adoptTab;

  // TerminalView is memoized, so what it gets must keep its identity from one
  // render to the next: the handlers sit behind a ref (always the latest
  // closures), and each tab gets one set of callbacks that call through it.
  const handlersRef = useRef({
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    patchHandoff,
  });
  handlersRef.current = {
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    patchHandoff,
  };
  const termCallbacksRef = useRef(
    new Map<
      string,
      {
        ref: (handle: TerminalHandle | null) => void;
        onTitleChange: (title: string) => void;
        onBusyChange: (busy: boolean) => void;
        onCommandLine: (line: string) => void;
        onAnchor: (anchor: PromptAnchor) => void;
        onPromptShown: (anchor: PromptAnchor | null) => void;
        onPtyReady: () => void;
      }
    >(),
  );
  function termCallbacks(tabId: string) {
    let callbacks = termCallbacksRef.current.get(tabId);
    if (!callbacks) {
      callbacks = {
        ref: (handle) => {
          if (handle) termRefs.current.set(tabId, handle);
          else termRefs.current.delete(tabId);
        },
        onTitleChange: (title) => handlersRef.current.title(tabId, title),
        onBusyChange: (busy) => handlersRef.current.busy(tabId, busy),
        onCommandLine: (line) => handlersRef.current.commandLine(tabId, line),
        onAnchor: (anchor) => handlersRef.current.patchHandoff(tabId, { anchor }),
        onPromptShown: (promptShown) => handlersRef.current.patchHandoff(tabId, { promptShown }),
        onPtyReady: () => setPtyVersion((v) => v + 1),
      };
      termCallbacksRef.current.set(tabId, callbacks);
    }
    return callbacks;
  }

  useEffect(() => {
    const webview = getCurrentWebviewWindow();
    const unlisten = webview.listen<TabTransfer>("tab:adopt", (e) => {
      adoptTabRef.current(e.payload);
      appWindow.setFocus().catch(() => {});
    });
    // Another window's Agents panel sending the user to one of our tabs.
    const unlistenFocus = webview.listen<string>("tab:focus", (e) => {
      // Empty for a notification about no tab in particular (notify_once).
      if (latestRef.current.tabs.some((t) => t.id === e.payload)) selectTabRef.current(e.payload);
    });
    // The remote-access server asking for the screen of one of our ptys (a
    // phone just opened it). Always answer, even empty, so it never waits.
    const unlistenSnap = webview.listen<{ reqId: string; ptyId: string }>("remote://snapshot-request", async (e) => {
      const { reqId, ptyId } = e.payload;
      let snap: { data: string; seq: number } | null = null;
      try {
        for (const h of termRefs.current.values()) {
          if (h.getPtyId() === ptyId) {
            snap = await h.snapshotForRemote();
            break;
          }
        }
      } catch {
        snap = null;
      }
      invoke("remote_snapshot_reply", { reqId, data: snap?.data ?? "", seq: snap?.seq ?? 0 }).catch(() => {});
    });
    // A phone sizing one of our ptys (or letting go of it): pin that
    // terminal's grid to the phone's, or let it refit.
    const unlistenSize = webview.listen<{ ptyId: string; cols: number | null; rows: number | null }>(
      "remote://size-override",
      (e) => {
        const { ptyId, cols, rows } = e.payload;
        for (const h of termRefs.current.values()) {
          if (h.getPtyId() === ptyId) {
            h.setSizeOverride(cols && rows ? { cols, rows } : null);
            break;
          }
        }
      },
    );
    // A phone tapping one of the published quick actions.
    const unlistenAction = webview.listen<{ id: string; ptyId: string | null }>("remote://run-action", (e) => {
      remoteActionRef.current(e.payload.id, e.payload.ptyId);
    });
    const unlistenLogin = webview.listen<{ id?: string; cli?: string }>("remote://profile-login", (e) => {
      if (e.payload.id && e.payload.cli) remoteProfileLoginRef.current(e.payload.id, e.payload.cli);
    });
    return () => {
      unlisten.then((off) => off());
      unlistenFocus.then((off) => off());
      unlistenSnap.then((off) => off());
      unlistenSize.then((off) => off());
      unlistenAction.then((off) => off());
      unlistenLogin.then((off) => off());
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
      next = [...next, makeTermTab(newTabId("tab"), cwd)];
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
    termCallbacksRef.current.delete(id);
    editorRefs.current.delete(id);
    pendingCommandsRef.current.delete(id);
    pendingShellOverrideRef.current.delete(id);
    explicitProfileRef.current.delete(id);
    inheritedProfileRef.current.delete(id);
    newTabShellRef.current.delete(id);
    pendingTypedCommandsRef.current.delete(id);
    pendingAttachRef.current.delete(id);
    pendingEditorContentRef.current.delete(id);
    restoredContentRef.current.delete(id);
    restoredTabIdsRef.current.delete(id);
    startDirPendingRef.current.delete(id);
    for (const [key, reserved] of reservedIdsRef.current) if (reserved === id) reservedIdsRef.current.delete(key);
    setHandoffs((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
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
        const newId = newTabId("tab");
        setTabs((prev) => prev.map((t) => (t.id === id ? makeTermTab(newId, cwd) : t)));
        setActiveTabId(newId);
        setActiveTerminalId(newId);
        forgetTab(id);
        return;
      }
    } else {
      const handle = editorRefs.current.get(id);
      if (handle?.isDirty()) {
        const ok = await confirm({
          title: t("app.unsaved.title"),
          message: t("app.unsaved.message", { name: tab.label }),
          confirmLabel: t("app.unsaved.confirm"),
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
    sessionDirtyRef.current = true;
    const trimmed = line.trim();
    const commandTab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    // Shown on the new tab page - only lines typed at a shell prompt (not
    // into a full-screen program, an ssh session or an agent), where the
    // tab's folder is really where the command ran.
    if (commandTab && !commandTab.busy && (!commandTab.nestedShell || commandTab.nestedShell === "wsl")) {
      recordRecentTerminal(commandTab.cwd, tabShell(commandTab), trimmed);
      recordCommand(tabShell(commandTab), trimmed);
    }

    const wslMatch = trimmed.match(/^wsl(?:\.exe)?(?:\s+(.*))?$/i);
    if (wslMatch) {
      const rest = wslMatch[1] ?? "";
      const distroMatch = rest.match(/(?:^|\s)(?:-d|--distribution)\s+(\S+)/i);
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "wsl", wslDistro: distroMatch?.[1] }));
      return;
    }

    const isInteractiveDocker =
      /^docker\s+(exec|run)\b/i.test(trimmed) && /(^|\s)(-it|-ti)(\s|$)|--interactive\b/i.test(trimmed);
    if (/^ssh\s+\S/i.test(trimmed) || isInteractiveDocker) {
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "remote", wslDistro: undefined }));
      return;
    }

    // Same tracking as `markAgentLaunching` (see its doc comment), but for
    // the CLI typed straight into the prompt rather than launched through a
    // shortcut - `checkCliAndMaybeLaunch` only ever sees the shortcut path.
    if (/^(claude|codex|vibe)(\.exe)?(?:\s|$)/i.test(trimmed)) {
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "agent", wslDistro: undefined }));
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
      patchTermTab(prev, tabId, (t) =>
        // Still the same WSL session? The user may have exited back to the
        // host shell (which clears `nestedShell`) while a lookup ran.
        t.nestedShell === "wsl" ? { cwd: winPath, explorerPath: winPath, wslDistro: resolvedDistro } : null,
      ),
    );
  }

  /** What a shell's reported title does to its tab: the patch to apply, and
   * any lookup that has to hit the filesystem first (applied when it
   * resolves). Pure - it only reads `t` - so the caller applies it with a
   * plain `setTabs`, and a title that changes nothing costs no render. */
  function resolveTitle(t: TermTab, rawTitle: string): { patch: Partial<TermTab>; after?: () => void } {
    const tabId = t.id;
    const trimmed = rawTitle.trim();
    const hostPrefix = trimmed.match(TITLE_HOST_PREFIX);
    const reportedUser = hostPrefix?.[1];
    const reportedPath = hostPrefix ? hostPrefix[2] : trimmed;
    const isWindows = isWindowsPlatform();
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
    if ((!isAbsolutePath(rawPath) && !isWslHomePath) || looksLikeExecutablePath(rawPath)) return { patch: { label } };

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
        return {
          patch: { label },
          after: () => {
            void invoke<boolean>("is_directory", { path: rawPath })
              .catch(() => false)
              .then((isDir) => {
                if (!isDir) return;
                setTabs((prev) =>
                  patchTermTab(prev, tabId, (t2) =>
                    // Still the same nested session? Anything that moved on
                    // since (exited, launched an agent) owns the tab now.
                    t2.nestedShell === nested
                      ? { cwd: rawPath, explorerPath: rawPath, nestedShell: undefined, wslDistro: undefined }
                      : null,
                  ),
                );
              });
          },
        };
      }
      // "<cwd> - <command>" while a command runs in cmd.exe: taken at
      // face value it's a folder that doesn't exist - and whatever is
      // the cwd when the app closes is what session restore reopens.
      // Resolved against the filesystem instead (deferred, like above).
      if (rawPath.includes(" - ")) {
        const cwdBefore = t.cwd;
        return {
          patch: { label, nestedShell: undefined, wslDistro: undefined },
          after: () => {
            void firstExistingDir(cmdTitlePathCandidates(rawPath)).then((dir) => {
              if (!dir) return;
              setTabs((prev) =>
                patchTermTab(prev, tabId, (t2) =>
                  // Unless a newer title already moved the tab on.
                  !t2.nestedShell && t2.cwd === cwdBefore ? { cwd: dir, explorerPath: dir } : null,
                ),
              );
            });
          },
        };
      }
      return { patch: { cwd: rawPath, explorerPath: rawPath, label, nestedShell: undefined, wslDistro: undefined } };
    }

    // From here `rawPath` is POSIX-shaped.
    if (t.nestedShell === "remote" || t.nestedShell === "agent") {
      // ssh / docker exec (this app has no way to read that filesystem)
      // or Claude Code/Codex (a real filesystem, but not what a POSIX-
      // shaped title fragment while its own TUI owns the screen would
      // mean here) - cwd/explorerPath are left exactly where they were
      // rather than pointed at a local path that means nothing.
      return { patch: { label } };
    }
    if (t.nestedShell === "wsl" && isWindows) {
      // Deferred (see `applyWslTitle`) even when the distro is already
      // known, so every WSL title takes the same one path through the
      // `~`-expansion; the lookups behind it are memoized and the update
      // it applies is idempotent for a given title.
      return { patch: { label }, after: () => void applyWslTitle(tabId, t.wslDistro, reportedUser, rawPath) };
    }

    // A plain POSIX path with no nested-shell context recognized - the
    // real local cwd (this app running on macOS/Linux, most commonly).
    return { patch: { cwd: rawPath, explorerPath: rawPath, label } };
  }

  function handleTitleChange(tabId: string, rawTitle: string) {
    // Decided from the committed tabs, outside the updater: an updater must
    // stay pure (StrictMode runs it twice), and this one starts lookups.
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab) return;
    const { patch, after } = resolveTitle(tab, rawTitle);
    setTabs((prev) => patchTermTab(prev, tabId, patch));
    after?.();
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

  function toggleTabNotifications(id: string) {
    setTabs((prev) => patchTermTab(prev, id, (t) => ({ notifyMuted: !t.notifyMuted })));
  }

  function handleEditorRenamed(id: string, newPath: string) {
    const label = basename(newPath);
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, path: newPath, label } : t)));
  }

  function handleBusyChange(tabId: string, busy: boolean) {
    sessionDirtyRef.current = true;
    setTabs((prev) =>
      patchTermTab(prev, tabId, (t) =>
        // The agent's full-screen UI closing is the one signal that it is gone
        // on a POSIX host, where no Windows-shaped title ever clears it.
        !busy && t.nestedShell === "agent" ? { busy, nestedShell: undefined } : { busy },
      ),
    );
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
      patchTermTab(prev, activeTerminalId, (t) =>
        // On the new tab page the browsed folder is also where the
        // terminal will start.
        ({ explorerPath: browsePath, ...(t.newTab ? { cwd: browsePath } : {}) }),
      ),
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
      const kind = fg.kind;
      term.navigateSilently((rows) => cdCommand(path, kind, rows), kind !== "cmd");
      return;
    }
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const distro = fg.wsl_distro ?? tab?.wslDistro ?? (await defaultWslDistro());
    const posixPath = distro ? toWslPath(distro, path) : null;
    if (!distro || !posixPath) return;
    setTabs((prev) =>
      patchTermTab(prev, tabId, (t) => (t.nestedShell !== "wsl" || !t.wslDistro ? { nestedShell: "wsl", wslDistro: distro } : null)),
    );
    term.navigateSilently((rows) => cdCommand(posixPath, "posix", rows), true);
  }

  const activeTerminal = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
  // Popups that pick an account profile start from the terminal in front.
  const activeTerminalProfileId = activeTerminal?.profileId;
  const activeTerminalKey = activeTerminal?.id;
  useEffect(() => {
    if (activeTerminalKey) activeTabProfile.set({ tabId: activeTerminalKey, profileId: activeTerminalProfileId });
  }, [activeTerminalKey, activeTerminalProfileId]);
  // The Agents panel's "This project" scope only makes sense while a terminal
  // is in front: with Settings or the changelog showing, the last terminal's
  // folder may not even be a project open in this window - and the new tab
  // page (a terminal tab with no shell yet) isn't one either.
  // The new tab page still gets the panel's "+" (it launches an agent in the
  // folder picked there), just not the project scope.
  const agentsTerminal = activeTerminal?.id === activeTabId ? activeTerminal : undefined;
  // The agent CLI running in each terminal tab, for its logo and status in
  // the tab strip - matched by pty id, same as the Agents panel does.
  const tabAgentsRef = useRef(new Map<string, TabAgent>());
  const { tabAgents, sessionByTab } = useMemo(() => {
    const byTab = new Map<string, AgentSession>();
    for (const session of agentSessions ?? []) {
      const tab = tabs.find((t) => t.kind === "terminal" && termRefs.current.get(t.id)?.getPtyId() === session.pty_id);
      if (tab) byTab.set(tab.id, session);
    }
    const next = new Map<string, TabAgent>();
    for (const [id, session] of byTab) next.set(id, tabAgentOf(session));
    // Same agents as before (a title change re-runs this): keep the old Map,
    // so the notification and auto-resume hooks see no change.
    const prev = tabAgentsRef.current;
    const same =
      prev.size === next.size && [...next].every(([id, a]) => prev.get(id)?.cli === a.cli && prev.get(id)?.state === a.state);
    if (same) return { tabAgents: prev, sessionByTab: byTab };
    tabAgentsRef.current = next;
    return { tabAgents: next, sessionByTab: byTab };
  }, [agentSessions, tabs, ptyVersion]);
  // The active tab's agent, for the usage popovers' context section.
  const activeAgentSession = activeTerminal ? sessionByTab.get(activeTerminal.id) : undefined;
  const [aaCli, aaId, aaProfile, aaWsl, aaLabel] = [
    activeAgentSession?.cli,
    activeAgentSession?.session_id ?? null,
    activeAgentSession?.profile ?? null,
    !!activeAgentSession?.wsl_distro,
    activeTerminal?.label ?? "",
  ];
  useEffect(() => {
    setActiveAgent(aaCli ? { cli: aaCli, sessionId: aaId, profile: aaProfile, wsl: aaWsl, tabLabel: aaLabel } : null);
  }, [aaCli, aaId, aaProfile, aaWsl, aaLabel]);
  useEffect(watchLimitResets, []);
  // The phone's usage view covers the plugins the user pinned (the enabled
  // ones), read live from this ref.
  const quickActionIdsRef = useRef<string[]>([]);
  quickActionIdsRef.current = quickActionIds;
  const usageWatchRef = useRef<UsageWatch | null>(null);
  useEffect(() => {
    const watch = watchUsageForRemote((id) => allPluginsRef.current.find((p) => p.id === id)?.label ?? id);
    usageWatchRef.current = watch;
    return () => {
      usageWatchRef.current = null;
      watch.dispose();
    };
  }, []);
  const quickActionsKey = quickActionIds.join(" ");
  useEffect(() => usageWatchRef.current?.refresh(), [quickActionsKey]);
  const doneTabIds = useAgentNotifications(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    isViewing: (id) => document.hasFocus() && latestRef.current.activeTabId === id,
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  const { armed: resumeArmed, cancel: cancelResume } = useAutoResume(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    getTerm: (id) => termRefs.current.get(id),
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  const sidebarCwd = activeTerminal?.explorerPath || homeDir;

  // Built-in labels come from t(), so a language change rebuilds them.
  const allPlugins = useMemo<PluginDef[]>(
    () => [...builtinPlugins(), ...customPlugins],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customPlugins, language],
  );
  const terminalTabs = useMemo(() => tabs.filter((t): t is TermTab => t.kind === "terminal"), [tabs]);

  // The quick actions a paired phone may trigger.
  const remoteActionsKey = JSON.stringify(
    quickActionIds.flatMap((id) => {
      const plugin = allPlugins.find((p) => p.id === id);
      return plugin && isPhoneAction(plugin.action) ? [{ id, label: plugin.label }] : [];
    }),
  );
  const remoteLeader = useRemoteLeader();
  useEffect(() => {
    if (remoteLeader) publishRemoteActions(JSON.parse(remoteActionsKey));
  }, [remoteActionsKey, remoteLeader]);
  // A phone's quick action waits here for its tab to become the active one,
  // then runs against that render's state.
  const pendingRemoteRunRef = useRef<{ tabId: string; plugin: PluginDef } | null>(null);
  useEffect(() => {
    const pending = pendingRemoteRunRef.current;
    if (!pending || pending.tabId !== activeTabId) return;
    pendingRemoteRunRef.current = null;
    runPluginRef.current(pending.plugin);
  }, [activeTabId]);

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
    setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "agent", wslDistro: undefined }));
  }

  /** The "X isn't installed" dialog, with a one-click install in a terminal. */
  async function offerCliInstall(cliBin: AgentCli) {
    const label = CLI_INFO[cliBin].label;
    const ok = await confirm({
      title: t("app.cli.notInstalled.title", { name: label }),
      message: t("app.cli.notInstalled.message", { name: label }),
      confirmLabel: t("app.cli.install"),
    });
    if (ok) openTerminalWithCommand(cliInstallCommand(cliBin, isWindowsPlatform()));
  }

  /** Before launching Claude Code / Codex / Mistral Vibe, offers a one-click install (if
   * missing) or login (if installed but signed out) in a fresh terminal
   * instead of the shortcut just quietly doing nothing useful. `check_cli_status`
   * (src-tauri/src/plugins.rs) does the actual detection. Resolves to whether
   * the CLI is ready to launch: true when it is installed and logged in, or
   * when detection itself failed (don't block the launch over it); false after
   * a dialog was shown. `profileId` is the account profile the CLI will run
   * under: its login state is the one checked, and the login offer opens a
   * terminal under it. */
  async function ensureCliReady(cliBin: AgentCli, profileId?: string): Promise<boolean> {
    const label = CLI_INFO[cliBin].label;
    let status: { installed: boolean; logged_in: boolean };
    try {
      status = await invoke("check_cli_status", { cli: cliBin, profile: profileId ?? null });
    } catch {
      // Detection itself failed - don't block the shortcut over it, just
      // fall back to the plain launch as before this check existed.
      return true;
    }

    if (!status.installed) {
      await offerCliInstall(cliBin);
      return false;
    }

    if (!status.logged_in) {
      const ok = await confirm({
        title: t("app.cli.login.title", { name: label }),
        // Vibe signs in with a Mistral API key, not an account login.
        message: t(cliBin === "vibe" ? "app.cli.login.vibeMessage" : "app.cli.login.message", { name: label }),
        confirmLabel: t("app.cli.login"),
      });
      if (ok) openTerminalWithCommand(CLI_INFO[cliBin].loginCommand, profileId);
      return false;
    }

    return true;
  }

  /** A CLI shortcut pressed in `tabId`. The project's default profile (see
   * src/profiles) decides which account the CLI should run under; a shell's
   * profile is fixed at spawn (env vars can't change on a running process),
   * so when the tab's own profile differs the CLI is started in a NEW tab
   * under the wanted one instead of being typed into this one. */
  async function checkCliAndMaybeLaunch(
    cliBin: AgentCli,
    launchCommand: string,
    term: TerminalHandle | undefined,
    tabId: string,
  ) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const wanted = tab?.cwd ? await profileForPath(tab.cwd) : null;
    // A WSL tab can't take a profile (the env vars don't reach the distro).
    // Only a project that *has* a default redirects: with none, the tab's own
    // profile (picked from the "+" menu, or a duplicated tab's) is respected.
    if (tab && wanted && tab.nestedShell !== "wsl" && wslDistroOfShell(tabShell(tab)) === undefined && wanted !== tab.profileId) {
      void launchAgentInNewTab(cliBin, tab.cwd, tabShell(tab), wanted);
      return;
    }
    if (await ensureCliReady(cliBin, tab?.profileId)) await launchInTab(cliBin, launchCommand, term, tabId);
  }

  /** Signs `cli` in under `profileId`: its login command in a fresh terminal
   * started under that profile (Settings > Profiles). */
  async function loginProfile(profileId: string, cli: AgentCli) {
    // A login command for a CLI that isn't installed would only print "command
    // not found" in the terminal - offer the install instead.
    const installed = await invoke<{ installed: boolean }>("check_cli_status", { cli, profile: profileId })
      .then((s) => s.installed)
      .catch(() => true);
    if (!installed) {
      await offerCliInstall(cli);
      return;
    }
    openTerminalWithCommand(CLI_INFO[cli].loginCommand, profileId);
  }

  remoteProfileLoginRef.current = (profileId, cli) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    void loginProfile(profileId, cli as AgentCli);
    // Signing in happens in the terminal, away from this window: keep re-reading
    // the login state for a while so the phone's list catches up.
    let left = 60;
    window.clearInterval(remoteLoginTimerRef.current);
    remoteLoginTimerRef.current = window.setInterval(() => {
      void refreshProfiles();
      if (--left <= 0) window.clearInterval(remoteLoginTimerRef.current);
    }, 5000);
  };

  /** Starts `cli` in a NEW tab opened in `cwd` (the Agents panel's "+" menu: the
   * project folder, or a fresh git worktree of it). `shell` is the shell the
   * project's own tab runs. Uses the CLI plugin's command, which may carry the
   * user's flags. A WSL shell runs the distro's own CLI, so it skips the host
   * install check and the host-only flags, like `openAgentSession`. The new
   * tab runs under account profile `profileId` (default profile when
   * omitted) - ignored for WSL, where the env vars don't reach. */
  async function launchAgentInNewTab(cli: AgentCli, cwd: string, shell?: string, profileId?: string) {
    let command = allPlugins.find((p) => cliOfPlugin(p.id) === cli)?.command ?? cli;
    if (wslDistroOfShell(shell) !== undefined) {
      const id = addTab(cwd, shell);
      pendingCommandsRef.current.set(id, command);
      return;
    }
    if (!(await ensureCliReady(cli, profileId))) return;
    if (cli === "vibe") await invoke("vibe_ensure_model", { profile: profileId ?? null }).catch(() => {});
    if (cli === "codex") command = await withCodexLaunchFlags(command);
    if (shell) {
      // addTab also activates the new tab.
      const id = addTab(cwd, shell, false, profileId ?? null);
      pendingCommandsRef.current.set(id, command);
      return;
    }
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, makeTermTab(id, cwd, { profileId })]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** Opens a plain terminal tab in `cwd` - a worktree from the Agents panel. */
  function openFolderTab(cwd: string) {
    addTab(cwd);
  }

  /** Types the CLI's launch command into `tabId` when a shell is at its
   * prompt there, or runs it in a new tab alongside when something else
   * already owns that tab's input (see `runInTabLike`). */
  async function launchInTab(cliBin: AgentCli, launchCommand: string, term: TerminalHandle | undefined, tabId: string) {
    const fg = await tabForeground(tabId);
    // Mistral Large 4 isn't one of Vibe's own models yet: registered in its
    // config (and made the default, unless the user picked another) before
    // each launch - a no-op once it's there. This host's Vibe only, same as
    // the Codex flags below. Never in the way of the launch itself.
    if (cliBin === "vibe" && fg?.kind !== "wsl" && fg?.kind !== "remote") {
      const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
      await invoke("vibe_ensure_model", { profile: tab?.profileId ?? null }).catch(() => {});
    }
    // Codex on Windows runs with `--no-daemon`, or its background server pops
    // a console window per helper - see plugins/codexLaunch.ts. That's this
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
    const command = plugin.action === "runCommand" || plugin.action === "commandOutput" ? plugin.command : undefined;
    // A plugin is a file anyone can drop in the plugins folder (or send): its
    // command is shown and confirmed before the first run, not just typed.
    // The app's own plugins - built in, or an unedited shipped example - are
    // trusted.
    const shipped = "id" in plugin ? examplePlugins().find((p) => p.id === plugin.id) : undefined;
    const trusted =
      !command ||
      ("builtin" in plugin && !!plugin.builtin) ||
      (!!shipped && shipped.action === plugin.action && shipped.command === command);
    if (trusted) {
      runPluginAction(plugin);
      return;
    }
    // A dialog's button belongs to the dialog plugin that is open.
    const owner = "id" in plugin ? plugin.id : (pluginDialog?.id ?? "");
    const approvalKey = `${owner}:${hashText(command)}`;
    const approved = readJson(PLUGIN_APPROVALS_KEY, isStringArray, []);
    if (approved.includes(approvalKey)) {
      runPluginAction(plugin);
      return;
    }
    void confirm({
      title: t("plugin.confirmRun.title"),
      message: t("plugin.confirmRun.message", { name: "id" in plugin ? plugin.label : (pluginDialog?.label ?? plugin.label), command }),
      confirmLabel: t("plugin.confirmRun.confirm"),
    }).then((ok) => {
      if (!ok) return;
      writeJson(PLUGIN_APPROVALS_KEY, [...readJson(PLUGIN_APPROVALS_KEY, isStringArray, []), approvalKey]);
      runPluginAction(plugin);
    });
  }

  function runPluginAction(plugin: PluginDef | PluginButtonDef) {
    switch (plugin.action) {
      case "newTerminal":
        openNewTab();
        break;
      case "clearTerminal":
        activeTermHandle()?.clear();
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
        // Claude Code / Codex CLI / Mistral Vibe take over the whole screen the moment
        // they start - unlike an arbitrary user-defined runCommand plugin,
        // there's no reason to leave the typed launch command sitting in
        // the scrollback above their UI. They're also the only plugins with
        // a known CLI binary behind them, which is what makes the
        // install/login pre-check possible - a plain runCommand plugin has
        // no such notion and always just runs.
        const cliBin = "id" in plugin ? cliOfPlugin(plugin.id) : undefined;
        if (cliBin) {
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
      case "openInVsCode":
        void openInVsCode();
        break;
    }
  }

  /** The "Apri in VS Code" feature: the active terminal's folder (or the
   * one the explorer is on, before the shell has reported any). A folder
   * inside WSL opens through VS Code's WSL remote, by its Linux path. */
  async function openInVsCode() {
    const tab = activeTerminal;
    if (tab?.nestedShell === "remote") {
      showPluginToast(t("plugin.openInVsCode.remote"));
      return;
    }
    const folder = tab?.cwd || tab?.explorerPath || "";
    if (!folder) {
      showPluginToast(t("plugin.openInVsCode.noFolder"));
      return;
    }
    const distro = wslDistroOfPath(folder);
    const posix = distro ? toWslPath(distro, folder) : null;
    try {
      await invoke("open_in_vscode", { folder: posix ?? folder, wslDistro: posix ? distro : null });
    } catch (e) {
      showPluginToast(
        String(e) === "vscode-not-found"
          ? t("plugin.openInVsCode.notInstalled")
          : t("app.openFailed", { name: "VS Code", error: String(e) }),
      );
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
  // a section index for the settings page, the version list for the
  // changelog and What's new - falling back to the explorer otherwise, since that's the
  // most broadly useful default.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  let sidebarPanel: ReactNode;
  if (activeTab?.kind === "settings") {
    sidebarPanel = <SettingsNav />;
  } else if (activeTab?.kind === "changelog") {
    sidebarPanel = <ChangelogNav view="changelog" />;
  } else if (activeTab?.kind === "whatsNew") {
    sidebarPanel = <ChangelogNav view="whatsNew" defaultVersion={activeTab.version} />;
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
        onGoHome={() =>
          void resolveStartDir(activeTerminal ? (tabShell(activeTerminal) ?? shellId) : shellId).then(browseExplorer)
        }
        onOpenFile={openFile}
        onOpenDiff={openDiff}
        onOpenTerminal={(path) => addTab(path, activeTerminal ? tabShell(activeTerminal) : undefined)}
        shell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
        linkMode={explorerLinkMode}
        onSetLinkMode={setExplorerLinkMode}
        terminalBusy={activeTerminal?.busy ?? false}
      />
    );
  }

  const themeModeLabels: Record<ThemeMode, string> = {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  };

  function moreMenuItems(): ContextMenuItem[] {
    return [
      {
        label: "zoom-row",
        custom: <ZoomRow tabId={activeTerminalId} />,
      },
      { separator: true, label: "sep-zoom" },
      { label: t("menu.newTerminal"), icon: Icons.newTerminal, onSelect: () => openNewTab() },
      {
        label: isFullscreen ? t("menu.exitFullscreen") : t("menu.fullscreen"),
        icon: isFullscreen ? Icons.fullscreenExit : Icons.fullscreen,
        onSelect: toggleFullscreen,
      },
      {
        label: t("favorites.title"),
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
        label: t("menu.theme"),
        icon: mode === "auto" ? Icons.themeAuto : mode === "light" ? Icons.sun : Icons.moon,
        submenu: (["auto", "light", "dark"] as ThemeMode[]).map((m) => ({
          label: themeModeLabels[m],
          icon: m === "auto" ? Icons.themeAuto : m === "light" ? Icons.sun : Icons.moon,
          checked: mode === m,
          onSelect: () => setMode(m),
        })),
      },
      { separator: true, label: "sep-theme" },
      { label: t("changelog.title"), icon: Icons.changelog, onSelect: openChangelog },
      { label: t("shortcuts.title"), icon: Icons.keyboard, onSelect: () => setShortcutsDialogOpen(true) },
      { label: t("settings.title"), icon: Icons.settings, onSelect: openSettings },
    ];
  }

  allPluginsRef.current = allPlugins;
  runPluginRef.current = runPlugin;
  remoteActionRef.current = (id, ptyId) => {
    const plugin = quickActionIds.includes(id) ? allPlugins.find((p) => p.id === id) : undefined;
    if (!plugin || !isPhoneAction(plugin.action)) return;
    // Plugins act on the active tab: bring the phone's tab forward first and
    // run once the re-render has made it the active one.
    let tabId: string | undefined;
    if (ptyId) {
      for (const [id, h] of termRefs.current) {
        if (h.getPtyId() === ptyId) tabId = id;
      }
    }
    if (tabId && tabId !== latestRef.current.activeTabId) {
      pendingRemoteRunRef.current = { tabId, plugin };
      selectTabRef.current(tabId);
      // If the tab never comes forward, don't run it later on a surprise tab.
      setTimeout(() => {
        if (pendingRemoteRunRef.current?.plugin === plugin) pendingRemoteRunRef.current = null;
      }, 2000);
    } else {
      runPlugin(plugin);
    }
  };

  // Narrow layout: the shortcuts as chips, and the "More" button's menu -
  // the wide header's Features button has no room, so it joins that menu.
  const narrowQuickActions = quickActionIds.flatMap((id) => {
    const plugin = allPlugins.find((p) => p.id === id);
    return plugin ? [{ id, label: plugin.label, icon: pluginIconNode(plugin), onRun: () => runPlugin(plugin) }] : [];
  });

  function openNarrowMore(rect: DOMRect) {
    const items: ContextMenuItem[] = [
      { label: t("settings.section.features"), icon: Icons.features, onSelect: () => setPluginMenuAnchor(rect) },
      { separator: true, label: "sep-features" },
      ...moreMenuItems(),
    ];
    // The menu clamps its top to fit the window, so asking for a spot as
    // high as it is tall puts its bottom edge just above the button.
    showMenu(rect.left, rect.top - items.length * 30 - 12, items);
  }

  return (
    <div className={`app-shell${isNarrow ? " is-narrow" : ""}${isMaximized ? " maximized" : ""}${isEdgeFlush ? " edge-flush" : ""}`}>
      <header className="app-headerbar" data-tauri-drag-region>
        {!isNarrow && (
          <button
            className={"icon-button" + (!sidebarCollapsed ? " is-active" : "")}
            aria-pressed={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((c) => !c)}
            onContextMenu={(e) =>
              openMenu(
                e,
                (
                  [
                    ["auto", t("sidebarMode.auto")],
                    ["docked", t("sidebarMode.docked")],
                    ["floating", t("sidebarMode.floating")],
                  ] as [SidebarMode, string][]
                ).map(([m, label]) => ({
                  label,
                  icon: m === "auto" ? MenuIcons.sidebarAuto : m === "docked" ? MenuIcons.sidebarDocked : MenuIcons.sidebarFloating,
                  checked: sidebarMode === m,
                  onSelect: () => setSidebarMode(m),
                })),
              )
            }
            aria-label={t("app.toggleSidebar")}
            title={t("app.toggleSidebar.title")}
          >
            <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
            </svg>
          </button>
        )}

        {isNarrow ? (
          <TabSwitcher
            tabs={tabs}
            activeId={activeTabId}
            agents={tabAgents}
            doneIds={doneTabIds}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={() => openNewTab()}
          />
        ) : (
          <TabStrip
            tabs={tabs}
            activeId={activeTabId}
            dirtyIds={dirtyIds}
            agents={tabAgents}
            doneIds={doneTabIds}
            resumeAt={resumeArmed}
            onCancelResume={cancelResume}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={(shellId, profileId) =>
              profileId !== undefined
                ? addTab(undefined, shellId, false, profileId)
                : shellId
                  ? addTab(undefined, shellId)
                  : openNewTab()
            }
            onRename={renameTab}
            onDuplicate={duplicateTab}
            onToggleNotifications={toggleTabNotifications}
            onReorder={reorderTab}
            onDragOut={(id) => void handleTabDragOut(id)}
          />
        )}

        <div className="header-right">
          {!isNarrow && (
            <>
            {quickActionIds.length > 0 && (
              <div className="quick-actions">
                {quickActionIds.map((id) => {
                  const plugin = allPlugins.find((p) => p.id === id);
                  if (!plugin) return null;
                  return (
                    <div
                      key={id}
                      onContextMenu={(e) =>
                        openMenu(e, [{ label: t("app.removeShortcut"), icon: MenuIcons.trash, danger: true, onSelect: () => toggleQuickAction(id) }])
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
              aria-label={t("settings.section.features")}
              title={t("settings.section.features")}
            >
              {Icons.features}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("app.moreOptions")}
              title={t("app.moreOptions")}
              onClick={(e) => openMenu(e, moreMenuItems())}
            >
              {Icons.kebab}
            </button>
            <button
              type="button"
              className={"icon-button" + (agentsSidebarOpen ? " is-active" : "")}
              aria-pressed={agentsSidebarOpen}
              aria-label={t("app.toggleAgents")}
              title={t("app.toggleAgents")}
              onClick={() => setAgentsSidebarOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <line x1="14.5" y1="4.5" x2="14.5" y2="19.5" />
              </svg>
            </button>
            </>
          )}
          {pluginMenuAnchor && (
            <PluginMenu items={pluginMenuEntries()} anchorRect={pluginMenuAnchor} onClose={() => setPluginMenuAnchor(null)} />
          )}
          <div className="window-controls">
            <button className="icon-button" aria-label={t("window.minimize")} onClick={() => appWindow.minimize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6" y1="12" x2="18" y2="12" />
              </svg>
            </button>
            <button className="icon-button" aria-label={t("window.maximize")} onClick={() => appWindow.toggleMaximize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.6">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
              </svg>
            </button>
            <button className="icon-button icon-button-close" aria-label={t("window.close")} onClick={() => appWindow.close()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
                <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <div className="app-body">
        {sidebarPresence.mounted && (
          <div
            className={
              "resizable-panel resizable-panel-left" +
              (sidebarPresence.shown ? "" : " is-hidden") +
              (sidebarResize.dragging ? " is-dragging" : "")
            }
            style={{ width: sidebarPresence.shown ? sidebarResize.width : 0 }}
          >
            <div className="panel-card">
              <div className="panel-card-content" style={{ width: sidebarResize.width - 2 }}>
                {sidebarPanel}
              </div>
            </div>
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
                const showPage = tab.newTab || handoffs.has(tab.id);
                // The startup tab has no cwd until the start folder is
                // resolved (see above) - mounting it earlier would spawn its
                // shell in whatever directory the app itself started in.
                const showTerminal = !tab.newTab && !!tab.cwd;
                const callbacks = termCallbacks(tab.id);
                return (
                  <Fragment key={tab.id}>
                    {showTerminal && (
                      <TerminalView
                        tabId={tab.id}
                        ref={callbacks.ref}
                        cwd={tab.cwd || undefined}
                        hidden={tab.id !== activeTabId}
                        onTitleChange={callbacks.onTitleChange}
                        onBusyChange={callbacks.onBusyChange}
                        onCommandLine={callbacks.onCommandLine}
                        runOnStart={pendingCommandsRef.current.get(tab.id)}
                        typeOnStart={pendingTypedCommandsRef.current.get(tab.id)}
                        shellOverride={pendingShellOverrideRef.current.get(tab.id)}
                        profileId={tab.profileId}
                        restoredContent={restoredContentRef.current.get(tab.id)}
                        attach={pendingAttachRef.current.get(tab.id)}
                        onAnchor={callbacks.onAnchor}
                        onPromptShown={callbacks.onPromptShown}
                        onPtyReady={callbacks.onPtyReady}
                      />
                    )}
                    {showPage && (
                      <NewTabPage
                        hidden={tab.id !== activeTabId}
                        defaultShell={shellId}
                        startDir={tab.cwd}
                        termFontSize={getTabFontSize(tab.id)}
                        onLaunch={(launch) => {
                          setHandoffs((prev) => new Map(prev).set(tab.id, {}));
                          launchFromNewTab(tab.id, launch);
                        }}
                        onShellChange={(shell) => previewNewTabShell(tab.id, shell)}
                        profileId={tab.profileId}
                        onProfileChange={(id) => {
                          explicitProfileRef.current.add(tab.id);
                          setTabs((prev) => patchTermTab(prev, tab.id, { profileId: id ?? undefined }));
                        }}
                        anchor={handoffs.get(tab.id)?.anchor}
                        promptShown={handoffs.get(tab.id)?.promptShown}
                        onDone={() =>
                          setHandoffs((prev) => {
                            const next = new Map(prev);
                            next.delete(tab.id);
                            return next;
                          })
                        }
                      />
                    )}
                  </Fragment>
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
              if (tab.kind === "diff") {
                return (
                  <Suspense key={tab.id} fallback={null}>
                    <DiffView root={tab.root} path={tab.path} staged={tab.staged} hidden={tab.id !== activeTabId} />
                  </Suspense>
                );
              }
              if (tab.id !== activeTabId) return null;
              if (tab.kind === "changelog") return <ChangelogPage key={tab.id} />;
              if (tab.kind === "whatsNew") {
                return <WhatsNewPage key={tab.id} version={tab.version} onOpenChangelog={openChangelog} />;
              }
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
                  onOpenShortcutsGuide={() => setShortcutsDialogOpen(true)}
                  onProfileLogin={loginProfile}
                />
              );
            })}
        </div>
        {effectiveSidebarMode === "floating" && !sidebarCollapsed && (
          <div className="sidebar-floating-backdrop" onClick={() => setSidebarCollapsed(true)}>
            <div
              className="sidebar-floating-panel"
              style={{ width: sidebarResize.width }}
              onClick={(e) => e.stopPropagation()}
            >
              {sidebarPanel}
            </div>
          </div>
        )}
        {isNarrow && agentsSidebarOpen && (
          <div className="sidebar-floating-backdrop" onClick={() => setAgentsSidebarOpen(false)} />
        )}
        {agentsPresence.mounted && (
          <div
            className={
              "resizable-panel resizable-panel-right" +
              (agentsPresence.shown ? "" : " is-hidden") +
              (agentsResize.dragging ? " is-dragging" : "")
            }
            style={{ width: agentsPresence.shown ? agentsResize.width : 0 }}
          >
            <div
              className={"resize-handle resize-handle-left" + (agentsResize.dragging ? " is-dragging" : "")}
              onPointerDown={agentsResize.onHandlePointerDown}
            />
            <div className="panel-card">
              <div className="panel-card-content" style={{ width: agentsResize.width - 2 }}>
                <AgentsSidebar
                  windowLabel={appWindow.label}
                  tabs={terminalTabs}
                  activeTabId={activeTabId}
                  projectCwd={
                    agentsTerminal
                      ? agentsTerminal.cwd || agentsTerminal.explorerPath || (agentsTerminal.newTab ? homeDir || undefined : undefined)
                      : undefined
                  }
                  newTabPage={!!agentsTerminal?.newTab}
                  projectWslDistro={agentsTerminal?.wslDistro ?? undefined}
                  sessions={agentSessions}
                  refreshSessions={refreshAgentSessions}
                  getPtyId={(tabId) => termRefs.current.get(tabId)?.getPtyId() ?? null}
                  onOpenTab={selectTab}
                  onOpenSession={openAgentSession}
                  projectShell={agentsTerminal ? tabShell(agentsTerminal) : undefined}
                  onLaunchAgent={(cli, cwd, shell, profileId) => void launchAgentInNewTab(cli, cwd, shell, profileId)}
                  onOpenFolder={openFolderTab}
                  onClose={() => setAgentsSidebarOpen(false)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      {isNarrow && (
        <NarrowBottom
          quickActions={narrowQuickActions}
          filesOpen={!sidebarCollapsed}
          agentsOpen={agentsSidebarOpen}
          onTerminal={() => {
            setSidebarCollapsed(true);
            setAgentsSidebarOpen(false);
          }}
          onToggleFiles={() => setSidebarCollapsed((c) => !c)}
          onToggleAgents={() => setAgentsSidebarOpen((o) => !o)}
          onMore={openNarrowMore}
        />
      )}
      {shortcutsDialogOpen && (
        <ShortcutsDialog
          onClose={() => setShortcutsDialogOpen(false)}
          onCustomize={() => {
            setShortcutsDialogOpen(false);
            setSettingsSection("shortcuts");
            openSettings();
          }}
        />
      )}
      {profilePickerOpen && (
        <ProfilePicker
          onClose={() => setProfilePickerOpen(false)}
          onPick={(id) => {
            setProfilePickerOpen(false);
            addTab(undefined, undefined, false, id);
          }}
        />
      )}
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
          <ChangelogProvider>
            <ConfirmDialogProvider>
              <UpdateProvider>
                <ContextMenuProvider>
                  <ShortcutsProvider>
                    <Shell />
                    <RemoteSettingsBridge />
                    <RemotePairConfirm />
                  </ShortcutsProvider>
                </ContextMenuProvider>
              </UpdateProvider>
            </ConfirmDialogProvider>
          </ChangelogProvider>
        </SettingsSectionProvider>
      </TerminalSettingsProvider>
    </ThemeProvider>
  );
}
