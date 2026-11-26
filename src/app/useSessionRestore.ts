import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppTab } from "../tabs/types";
import { loadSession, type SavedWindow } from "../session/session";
import { useWindowSession } from "../session/useWindowSession";
import { prepareEditorClose } from "../editor/closeEditors";
import { wslDistroOfShell } from "../terminal/wslPath";
import { basename } from "../lib/path";
import { cmdTitlePathCandidates, firstExistingDir, labelForCwd } from "../terminal/tabTitle";
import { takeWindowInit } from "../tabs/transfer";
import { newTabId } from "../tabs/tabId";
import { makeTermTab } from "../tabs/tabState";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import type { ShellCtx } from "./shellContext";
import { appWindow, isMainWindow } from "./appWindow";

/** Reads the previous session (or a tab handed over from another window) back at startup, and keeps saving it. */
export function useSessionRestore(S: ShellCtx) {
  const {
    adoptTabRef, chooseClose, editorRefs, latestRef, pendingEditorContentRef, pendingShellOverrideRef,
    restoreContentRef, restoreSessionRef, restoredContentRef, restoredTabIdsRef, sessionChecked, sessionDirtyRef,
    setActiveTabId, setActiveTerminalId, setSessionChecked, setTabs, t, tabShell, termRefs,
  } = S;
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
          if (t.content && restoreContentRef.current) restoredContentRef.current.set(id, t.content);
          if (t.shell) pendingShellOverrideRef.current.set(id, t.shell);
          restored.push({
            kind: "terminal",
            id,
            cwd,
            explorerPath: cwd,
            label: t.customLabel || !cwd ? t.label : labelForCwd(cwd),
            customLabel: t.customLabel,
            notifyMuted: t.notifyMuted,
            peerAccept: t.peerAccept,
            nestedShell: wslDistro !== undefined ? "wsl" : undefined,
            wslDistro: wslDistro ?? undefined,
            profileId: t.profileId,
          });
        } else if (t.kind === "chat") {
          // A folder deleted since can't host the agent: the tab is dropped.
          if (await firstExistingDir([t.cwd])) {
            const keepChat = restoreContentRef.current;
            restored.push({
              kind: "chat",
              id: newTabId("chat"),
              agent: t.agent as AgentCli,
              cwd: t.cwd,
              label: keepChat ? t.label : basename(t.cwd) || CLI_INFO[t.agent as AgentCli].name,
              profileId: t.profileId,
              sessionId: keepChat ? t.sessionId : undefined,
              viewId: t.viewId,
              shell: t.shell,
              // No saved session (or not restoring it): a fresh chat, nothing to resume yet.
              talked: keepChat && t.sessionId ? undefined : false,
              lastActiveAt: keepChat ? t.lastActiveAt : undefined,
              peerAccept: t.peerAccept,
            });
          }
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
      if (restored.length === 0) restored.push(makeTermTab("tab-0", ""));
      const active = restored[Math.min(Math.max(saved.activeIndex, 0), restored.length - 1)];
      setTabs(restored);
      setActiveTabId(active.id);
      setActiveTerminalId(active.kind === "terminal" ? active.id : (restored.find((r) => r.kind === "terminal")?.id ?? ""));
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

  useWindowSession({
    ready: sessionChecked,
    window: appWindow,
    main: isMainWindow,
    dirty: sessionDirtyRef,
    onError: (error) => window.alert(t("app.sessionSaveFailed", { error: String(error) })),
    restore: () => restoreSessionRef.current,
    state: () => ({
      ...latestRef.current,
      restoreContent: restoreContentRef.current,
      dirtyEditors: latestRef.current.tabs.some((tab) => tab.kind === "editor" && (editorRefs.current.get(tab.id)?.isDirty() ?? pendingEditorContentRef.current.has(tab.id))),
      restoredTabIds: restoredTabIdsRef.current,
      terminals: termRefs.current,
      restoredContent: restoredContentRef.current,
      shellOf: tabShell,
    }),
    prepareClose: () => prepareEditorClose(
      () => latestRef.current.tabs.flatMap((tab) => {
        if (tab.kind !== "editor") return [];
        const pending = pendingEditorContentRef.current.get(tab.id);
        const handle = editorRefs.current.get(tab.id) ?? (pending !== undefined ? {
          isDirty: () => true, getContent: () => pending, save: async () => false,
        } : undefined);
        return handle ? [{ id: tab.id, label: tab.label, handle }] : [];
      }),
      async (editor) => {
        const choice = await chooseClose({
          title: t("app.unsaved.title"),
          message: t("app.unsaved.windowMessage", { name: editor.label }),
          confirmLabel: t("app.unsaved.save"),
          alternativeLabel: t("app.unsaved.confirm"),
        });
        return choice === "confirm" ? "save" : choice === "alternative" ? "discard" : "cancel";
      },
    ),
  });
}
