import { invoke } from "@tauri-apps/api/core";
import type { TermTab } from "../tabs/types";
import { shellStartKey } from "../terminal/TerminalSettingsContext";
import { resolveWslStartDir, wslDistroOfPath, wslDistroOfShell, wslShellId } from "../terminal/wslPath";
import { resolveNewTabLayout } from "../newtab/layouts";
import type { NewTabLaunch } from "../newtab/types";
import { profileForPath } from "../profiles/profiles";
import { labelForCwd } from "../terminal/tabTitle";
import { newTabId } from "../tabs/tabId";
import { isDialogTab, makeTermTab, patchTermTab } from "../tabs/tabState";
import type { NewTabsCtx } from "./shellContext";

/** Creating terminal tabs: the new tab page/dialog, start folder and automatic profile, launching from the page. */
export function useNewTabs(S: NewTabsCtx) {
  const {
    explicitProfileRef, forgetTab, homeDir, inheritedProfileRef, latestRef, newTabLayoutId, newTabPage,
    newTabShellRef, pendingCommandsRef, pendingShellOverrideRef, pendingTypedCommandsRef, resolvedStartPath,
    setActiveTabId, setActiveTerminalId, setTabs, shellId, shellStartPaths, startDirPendingRef, t, tabShell,
  } = S;
  /** A new tab showing the new tab page (see src/newtab) instead of
   * starting the default shell straight away - what "+", Ctrl+T and "Nuovo
   * terminale" open. With the page turned off in Settings it is the default
   * shell straight away, like the tab strip's per-shell menu entries. */
  function openNewTab(): string {
    if (!newTabPage) return addTab();
    // A layout that is a dialog (see NewTabLayoutDef.dialog): no tab. One at a time.
    if (resolveNewTabLayout(newTabLayoutId).dialog) {
      const open = latestRef.current.tabs.find(isDialogTab);
      if (open) {
        focusNewTabDialog();
        return open.id;
      }
      return addTab(undefined, undefined, true, undefined, true);
    }
    return addTab(undefined, undefined, true);
  }

  function focusNewTabDialog() {
    document.querySelector<HTMLElement>(".glass-newtab.is-dialog .glass-search-input")?.focus();
  }

  /** Closes the new tab dialog without launching anything: the draft tab goes,
   * the tab that was in front never stopped being it. */
  function dismissNewTabDialog(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    forgetTab(id);
    // The terminal lost the focus to the dialog's field.
    requestAnimationFrame(() => {
      const fields = document.querySelectorAll<HTMLElement>(".terminal-pane .xterm-helper-textarea");
      Array.from(fields)
        .find((el) => el.offsetParent !== null)
        ?.focus();
    });
  }

  /** `profileId`: `undefined` = automatic (the folder's project default
   * profile, else the active terminal's), `null` = the default profile on
   * purpose, a string = that profile on purpose. */
  function addTab(cwdOverride?: string, shellOverride?: string, newTab = false, profileId?: string | null, dialog = false): string {
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
        ...(dialog ? { dialog } : {}),
      },
    ]);
    if (!cwd) fillStartDir(id, shellOverride ?? shellId, cwdOverride);
    // A dialog is over the tab in front, which stays it until a launch.
    if (!dialog) {
      setActiveTabId(id);
      setActiveTerminalId(id);
    }
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
      // The dialog closes into the new terminal: it takes the front, no hand-off fade.
      if (tab.dialog) {
        setActiveTabId(tabId);
        setActiveTerminalId(tabId);
      }
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) => ({
          newTab: undefined,
          dialog: undefined,
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
  return {
    openNewTab, dismissNewTabDialog, addTab, resolveStartDir, automaticProfile, fillStartDir, previewNewTabShell,
    launchFromNewTab, runInTabLike, openTerminalWithCommand,
  };
}
