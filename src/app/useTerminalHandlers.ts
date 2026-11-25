import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TermTab } from "../tabs/types";
import { defaultOpensChat } from "../agentViews/defaultView";
import { defaultWslDistro, sameShell, toWindowsPath, toWslPath, wslDistroOfPath, wslDistroOfShell, wslShellId } from "../terminal/wslPath";
import type { FavoriteFolder } from "../favorites/favoritesStore";
import { cdCommand } from "../terminal/shellDialect";
import { recordRecentTerminal } from "../newtab/recentTerminals";
import { recordCommand } from "../newtab/commandHistory";
import { profileForPath } from "../profiles/profiles";
import { resolveTitle } from "../terminal/titleResolver";
import { patchTermTab } from "../tabs/tabState";
import type { AgentCli } from "../agents/cliInfo";
import type { TerminalHandlersCtx } from "./shellContext";

/** What terminal tabs report (title, busy, command lines) and the explorer driving their shell. */
export function useTerminalHandlers(S: TerminalHandlersCtx) {
  const {
    activeTabId, activeTerminal, activeTerminalId, addTab, explorerLinkMode, homeDir, latestRef, launchFromNewTab,
    patchChatTab, patchHandoff, sessionDirtyRef, setPtyVersion, setTabs, shellId, showPluginToast, t,
    tabForeground, tabShell, tabs, termCallbacksRef, termRefs,
  } = S;
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

  // TerminalView is memoized, so what it gets must keep its identity from one
  // render to the next: the handlers sit behind a ref (always the latest
  // closures), and each tab gets one set of callbacks that call through it.
  const handlersRef = useRef({
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    interceptCommandLine,
    patchHandoff,
    openDelegate: (...args: Parameters<TerminalHandlersCtx["openDelegateTab"]>) => S.openDelegateTab(...args),
  });
  handlersRef.current = {
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    interceptCommandLine,
    patchHandoff,
    openDelegate: (...args: Parameters<TerminalHandlersCtx["openDelegateTab"]>) => S.openDelegateTab(...args),
  };
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
        interceptCommandLine: (line) => handlersRef.current.interceptCommandLine(tabId, line),
        onAnchor: (anchor) => handlersRef.current.patchHandoff(tabId, { anchor }),
        onPromptShown: (promptShown) => handlersRef.current.patchHandoff(tabId, { promptShown }),
        onPtyReady: () => setPtyVersion((v) => v + 1),
        onOpenDelegate: (delegate, wslDistro) => handlersRef.current.openDelegate(tabId, delegate, wslDistro),
      };
      termCallbacksRef.current.set(tabId, callbacks);
    }
    return callbacks;
  }

  /** A bare agent CLI typed at a host shell prompt (`claude`, `codex`, ...)
   * while chat is the default agent view: opened as a chat tab in the tab's
   * folder instead of running in the terminal. A line with arguments, and a
   * prompt that isn't a plain host shell (busy, WSL, ssh, an agent), runs as typed. */
  function interceptCommandLine(tabId: string, line: string): boolean {
    const match = line.trim().match(/^(claude|codex|vibe|gemini|opencode|cline)(?:\.exe)?$/i);
    if (!match || !defaultOpensChat()) return false;
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab || tab.busy || tab.nestedShell || wslDistroOfShell(tabShell(tab)) !== undefined) return false;
    const cli = match[1].toLowerCase() as AgentCli;
    void profileForPath(tab.cwd).then((wanted) => S.openChatTab(cli, tab.cwd, { profileId: (wanted ?? tab.profileId) ?? undefined, replaceTabId: tabId }));
    return true;
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
    if (/^(claude|codex|vibe|gemini|opencode|cline)(\.exe)?(?:\s|$)/i.test(trimmed)) {
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "agent", wslDistro: undefined }));
    }
  }

  function handleTitleChange(tabId: string, rawTitle: string) {
    // Decided from the committed tabs, outside the updater: an updater must
    // stay pure (StrictMode runs it twice), and this one starts lookups.
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab) return;
    const { patch, after } = resolveTitle(tab, rawTitle, homeDir, setTabs);
    setTabs((prev) => patchTermTab(prev, tabId, patch));
    after?.();
  }

  /** Dumps what the agent detection sees for this tab (see agent_detection_dump) to the clipboard. */
  async function copyAgentDiagnostics(id: string) {
    const ptyId = termRefs.current.get(id)?.getPtyId();
    try {
      const report = await invoke<string>("agent_detection_dump", { ptyId: ptyId ?? null });
      await navigator.clipboard.writeText(report);
      showPluginToast(t("tabs.agentDiagnostics.copied"));
    } catch (e) {
      showPluginToast(String(e));
    }
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

  /** Sidebar navigation actually `cd`s the active shell (so it's really
   * there for the next command), but hides the injected command and its
   * echo completely - the terminal's on-screen content is untouched. `cwd`/
   * label catch up on their own next real prompt (OSC title update), same
   * as after a manually-typed `cd`. Skipped entirely while the explorer is
   * disconnected (by hand, or auto-suspended because a full-screen program
   * owns the shell) - the sidebar still moves, it just stops typing into it. */
  function browseExplorer(path: string) {
    // A chat has no shell to `cd` and no terminal explorer state: it keeps its own.
    const front = tabs.find((t) => t.id === activeTabId);
    if (front?.kind === "chat") {
      patchChatTab(front.id, { explorerPath: path });
      return;
    }
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
  return {
    openFavorite, termCallbacks, interceptCommandLine, copyAgentDiagnostics, browseExplorer,
  };
}
