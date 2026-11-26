import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { isLikelyTextFile } from "../sidebar/fileIcons";
import { forgetBrowserTab } from "../browser/browserStore";
import type { AppTab, ChatPane, ChatTab, PeerAccept, TermTab } from "../tabs/types";
import type { GitChange } from "../git/gitStatus";
import { toWindowsPath, wslDistroOfPath, wslShellId } from "../terminal/wslPath";
import { basename } from "../lib/path";
import { ptyForeground, type Foreground } from "../terminal/shellDialect";
import { packTabTransfer, tabStripDropIndex, type CursorTarget, type TabTransfer } from "../tabs/transfer";
import { newChatPane as newChatPaneIn, patchChatPane as patchChatPaneIn, patchChatTab as patchChatTabIn, showChatSession as showChatSessionIn } from "../tabs/chatPanes";
import { newTabId } from "../tabs/tabId";
import { isDialogTab, listedTabs, makeTermTab, patchTermTab } from "../tabs/tabState";
import type { TabsCtx } from "./shellContext";
import { appWindow } from "./appWindow";

/** Tab lifecycle: selecting, opening editors/diffs/singletons, moving between windows, closing. */
export function useTabs(S: TabsCtx) {
  const {
    activeTabId, activeTerminal, editorRefs, explicitProfileRef, forgetTabPanels, homeDir, inheritedProfileRef,
    latestRef, newTabShellRef, pendingAttachRef, pendingCommandsRef, pendingEditorContentRef,
    pendingShellOverrideRef, pendingTypedCommandsRef, reservedIdsRef, resetTabZoom, resolvedStartPath,
    restoredContentRef, restoredTabIdsRef, sessionDirtyRef, setActiveTabId, setActiveTerminalId, setDirtyIds,
    setHandoffs, setSidebarCollapsed, setTabFontSize, setTabs, showPluginToast, startDirPendingRef, stripTabs, t,
    tabFontSizeOverrides, tabs, termCallbacksRef, termRefs, confirm,
  } = S;
  /** Ctrl+Tab / Ctrl+Shift+Tab: the next/previous tab in strip order,
   * wrapping around at the ends. */
  function stepTab(delta: number) {
    if (stripTabs.length < 2) return;
    const i = stripTabs.findIndex((t) => t.id === activeTabId);
    selectTab(stripTabs[(i + delta + stripTabs.length) % stripTabs.length].id);
  }

  /** Ctrl+1..9: the tab at that position - out of range does nothing. */
  function selectTabAt(index: number) {
    const tab = stripTabs[index];
    if (tab) selectTab(tab.id);
  }

  function moveActiveTab(delta: number) {
    const i = stripTabs.findIndex((t) => t.id === activeTabId);
    const to = i + delta;
    if (i !== -1 && to >= 0 && to < stripTabs.length) reorderTab(activeTabId, to);
  }

  function selectTab(id: string) {
    setActiveTabId(id);
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    if (tab?.kind === "terminal") setActiveTerminalId(id);
  }
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;

  /** What's at the front of a tab's terminal right now - see shellDialect.ts. */
  function tabForeground(tabId: string): Promise<Foreground | null> {
    return ptyForeground(termRefs.current.get(tabId)?.getPtyId());
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
      S.addTab(tab.cwd, tabShell(tab), false, tab.profileId ?? null);
      return;
    }
    if (tab.kind === "chat") {
      void S.openChatTab(tab.agent, tab.cwd, { profileId: tab.profileId, viewId: tab.viewId });
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
    openInEditor(path);
  }

  /** Opens (or focuses) `path` in an editor tab, whatever its extension - the
   * caller already knows it is text (a chat/terminal path link: the backend
   * sniffed it) - and moves to `line` (1-based) when given. */
  function openInEditor(path: string, line?: number) {
    const existing = latestRef.current.tabs.find((t) => t.kind === "editor" && t.path === path);
    // Two opens before the next render both miss `existing`: they share one
    // id, and the updater drops the second add.
    const id = existing?.id ?? reservedTabId(`editor:${path}`, "editor");
    if (!existing) {
      setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { kind: "editor", id, path, label: basename(path) }]));
    }
    setActiveTabId(id);
    if (line && line > 0) {
      // A new tab's editor mounts on a later render; it keeps the line until its text is loaded.
      const reveal = (attempt: number) => {
        const handle = editorRefs.current.get(id);
        if (handle) handle.scrollToLine(line);
        else if (attempt < 40) window.setTimeout(() => reveal(attempt + 1), 50);
      };
      reveal(0);
    }
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

  const adoptTabRef = useRef(adoptTab);
  adoptTabRef.current = adoptTab;

  /** Everything the receiving window needs to rebuild `tab` - for a terminal
   * this detaches its running session from this window (see
   * `TerminalHandle.release`). `null` when it can't move (a terminal whose
   * shell hasn't started yet). */
  function packTab(tab: AppTab): Promise<TabTransfer | null> {
    return packTabTransfer(tab, {
      terminal: termRefs.current.get(tab.id),
      editor: editorRefs.current.get(tab.id),
      pendingEditorContent: pendingEditorContentRef.current.get(tab.id),
      shell: tab.kind === "terminal" ? tabShell(tab) : undefined,
      fontSize: tabFontSizeOverrides[tab.id],
    });
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
    // A chat can't change window: its agent lives in this one.
    if (!tab || tab.kind === "chat") return;
    const target = await invoke<CursorTarget>("window_at_cursor").catch(() => null);
    if (!target) return;
    const alone = listedTabs(latestRef.current.tabs).length === 1;
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
    forgetBrowserTab(id);
    forgetTabPanels(id);
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
    // The new-tab dialog draft doesn't count: closing the only real tab closes the window.
    if (!isDialogTab(tab) && listedTabs(latestRef.current.tabs).length === 1) {
      void appWindow.close();
      return;
    }
    if (tab.kind !== "terminal") {
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
      // Conversations parked in the background that are mid-turn end with the tab.
      const working = tab.kind === "chat" ? (tab.parked ?? []).filter((p) => p.status === "busy" || p.status === "waiting").length : 0;
      if (working > 0) {
        const ok = await confirm({
          title: t("app.parkedBusy.title"),
          message: t("app.parkedBusy.message", { count: working }),
          confirmLabel: t("app.parkedBusy.confirm"),
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
    // Closing the very last tab of any kind mirrors a plain terminal app:
    // nothing left to show, so close the window rather than leave it empty.
    // Any other tab can go, terminals included - a window holding just
    // Settings or an editor is fine.
    if (current.tabs.length === 1 || (!isDialogTab(tab) && listedTabs(current.tabs).length === 1)) {
      appWindow.close();
      return;
    }
    // A chat's delegated children's tabs go with it (the backend closes the children).
    const next = current.tabs.filter((t) => t.id !== id && !(t.kind === "chat" && t.delegate?.parentTabId === id));
    if (next.length === 0) {
      appWindow.close();
      return;
    }
    if (id === current.activeTabId || !next.some((t) => t.id === current.activeTabId)) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (id === current.activeTerminalId) {
      // No terminal left (e.g. only Settings open) is fine: "" just means
      // no terminal is in front until a new one opens.
      setActiveTerminalId(next.find((t) => t.kind === "terminal")?.id ?? "");
    }
    setTabs((prev) => prev.filter((t) => t.id !== id && !(t.kind === "chat" && t.delegate?.parentTabId === id)));
    forgetTab(id);
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

  /** How a terminal or chat tab answers messages from other agents; undefined = the global default. */
  function setTabPeerAccept(id: string, peerAccept: PeerAccept | undefined) {
    setTabs((prev) => prev.map((t) => (t.id === id && (t.kind === "terminal" || t.kind === "chat") ? { ...t, peerAccept } : t)));
  }

  function handleEditorRenamed(id: string, newPath: string) {
    const label = basename(newPath);
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, path: newPath, label } : t)));
  }

  function handleDirtyChange(id: string, dirty: boolean) {
    sessionDirtyRef.current = true;
    setDirtyIds((prev) => {
      const has = prev.has(id);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Bookkeeping after a terminal tab left the strip: its handles, and the
   * active terminal when it was that one. */
  function dropTerminal(terminalId: string) {
    forgetTab(terminalId);
    setActiveTerminalId((active) => (active === terminalId ? (latestRef.current.tabs.find((t) => t.kind === "terminal" && t.id !== terminalId)?.id ?? "") : active));
  }

  /** Patches a chat tab's fields as its view reports them. */
  function patchChatTab(id: string, patch: Partial<ChatTab>) {
    setTabs((prev) => patchChatTabIn(prev, id, patch));
  }

  /** Patches one conversation of a chat tab: the shown one lives on the tab, a parked one in `parked`. */
  function patchChatPane(tabId: string, paneKey: string, patch: Partial<ChatPane>) {
    setTabs((prev) => patchChatPaneIn(prev, tabId, paneKey, patch));
  }

  /** Shows `sessionId` in chat tab `tabId`: a parked conversation of it is swapped in, otherwise a new one
   * starts resuming it. */
  function showChatSession(tabId: string, sessionId: string, lastActiveAt?: number) {
    setTabs((prev) => showChatSessionIn(prev, tabId, sessionId, lastActiveAt));
  }

  /** Starts a fresh conversation in chat tab `tabId`, beside the one shown (which keeps running in the background). */
  function newChatPane(tabId: string) {
    setTabs((prev) => newChatPaneIn(prev, tabId));
  }

  /** A History row open in a tab was picked: the tab comes forward, showing that conversation if it is a parked one. */
  function openHistoryTab(tabId: string, sessionId?: string) {
    if (sessionId) showChatSession(tabId, sessionId);
    selectTab(tabId);
  }
  return {
    stepTab, selectTabAt, moveActiveTab, selectTab, tabForeground, tabShell, duplicateTab, openFile, openInEditor,
    openDiff, openSettings, openChangelog, openWhatsNew, reorderTab, adoptTab, handleTabDragOut, forgetTab,
    closeTab, renameTab, toggleTabNotifications, setTabPeerAccept, handleEditorRenamed, handleDirtyChange, dropTerminal,
    patchChatTab, patchChatPane, showChatSession, newChatPane, openHistoryTab, selectTabRef, adoptTabRef,
  };
}
