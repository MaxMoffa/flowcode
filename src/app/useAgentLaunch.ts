import { invoke } from "@tauri-apps/api/core";
import type { TerminalHandle } from "../terminal/Terminal";
import { isSafeSessionId } from "../agents/sessionId";
import type { AppTab, ChatTab, TermTab } from "../tabs/types";
import { defaultAgentView, defaultOpensChat } from "../agentViews/defaultView";
import { getConfiguredShell } from "../terminal/TerminalSettingsContext";
import { toWindowsPath, toWslPath, wslDistroOfPath, wslDistroOfShell, wslShellId } from "../terminal/wslPath";
import { cliInstallCommand } from "../cli/cliInstallCommands";
import { basename, isWindowsPlatform } from "../lib/path";
import { withCodexLaunchFlags } from "../plugins/codexLaunch";
import { atShellPrompt } from "../terminal/shellDialect";
import { profileForPath } from "../profiles/profiles";
import { openProviderAuth } from "../profiles/providerAuth";
import { newTabId } from "../tabs/tabId";
import { makeTermTab, patchTermTab } from "../tabs/tabState";
import { AGENT_CLIS, CLI_INFO, cliOfPlugin, type AgentCli } from "../agents/cliInfo";
import type { DelegateInfo } from "../chat/chatModel";
import type { AgentLaunchCtx } from "./shellContext";
import { insertTabAt, resumeCommand } from "./tabHelpers";
import type { DelegateParent, ChatCallbacks, OpenChatOptions } from "./types";

/** Starting agents: resuming sessions, chat tabs, delegate tabs, chat <-> terminal handoffs, CLI install/login checks. */
export function useAgentLaunch(S: AgentLaunchCtx) {
  const {
    addTab, allPlugins, automaticProfile, chatCallbacksRef, chatClosersRef, dropTerminal, explicitProfileRef,
    forgetTab, homeDir, latestRef, openHistoryTab, openTerminalWithCommand, patchChatTab, pendingCommandsRef,
    resumingRef, runInTabLike, setActiveTabId, setActiveTerminalId, setTabs, showChatSession, showPluginToast,
    switchingChatsRef, t, tabForeground, tabShell, termRefs, confirm,
  } = S;
  /** Opens a fresh terminal tab in `cwd`, resuming a specific agent session
   * the moment its shell is ready - used from the Agents sidebar for a
   * background/saved session (one this app has no open tab for), so
   * double-clicking it drops the user straight back into that chat instead
   * of a bare shell they'd have to resume by hand. */
  async function openAgentSession(cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string, at?: number) {
    // Typed into a shell below: an id that isn't a plain token is never run.
    if (!isSafeSessionId(sessionId)) {
      console.warn("refusing to resume a session with an unexpected id", JSON.stringify(sessionId));
      return;
    }
    if (wslDistro) {
      // Saved inside WSL: resumed by the distro's own CLI, in a WSL tab
      // opened on that folder (`cwd` is a Linux path there). The
      // `--no-daemon` check is about Windows' Job Object - not WSL's concern.
      const command = await resumeCommand(cli, sessionId, false, profileId);
      const id = addTab(toWindowsPath(wslDistro, cwd), wslShellId(wslDistro));
      pendingCommandsRef.current.set(id, command);
      return;
    }
    const command = await resumeCommand(cli, sessionId, true, profileId);
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => insertTabAt(prev, makeTermTab(id, cwd, { profileId }), at));
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** The agent view something picked in the History opens in: what a phone asked for, else the kind of tab the History
   * is shown for (a chat's opens a chat, a terminal's a terminal), else the default agent view. */
  function historyView(view?: "chat" | "terminal"): "chat" | "terminal" {
    if (view) return view;
    const { tabs: all, activeTabId: front } = latestRef.current;
    const kind = all.find((t) => t.id === front)?.kind;
    if (kind === "chat" || kind === "terminal") return kind;
    return defaultOpensChat() ? "chat" : "terminal";
  }

  /** The tab running agent session `sessionId` already: a chat (shown or in its background) or a terminal agent. */
  function tabWithSession(sessionId: string): AppTab | undefined {
    return latestRef.current.tabs.find((t) =>
      t.kind === "chat"
        ? t.sessionId === sessionId || (t.parked ?? []).some((p) => p.sessionId === sessionId)
        : t.kind === "terminal" && S.sessionByTab.get(t.id)?.session_id === sessionId,
    );
  }

  /** A saved session picked in the History (or from a phone): resumed in the view `historyView` picks. A session
   * already open in a tab brings that tab forward instead: two processes must never share one session. */
  function resumeAgentSession(cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string, lastActiveAt?: number, view?: "chat" | "terminal") {
    const holder = sessionId ? tabWithSession(sessionId) : undefined;
    if (holder) {
      openHistoryTab(holder.id, holder.kind === "chat" ? sessionId : undefined);
      return;
    }
    const busyKey = `${cli}:${sessionId}`;
    if (resumingRef.current.has(busyKey)) return;
    resumingRef.current.add(busyKey);
    // Kept a moment past the start, until the new tab is in the strip for tabWithSession to find.
    const done = () => setTimeout(() => resumingRef.current.delete(busyKey), 1000);
    const { tabs: all, activeTabId: front } = latestRef.current;
    if (historyView(view) === "chat") {
      // Saved inside WSL: a chat in that distro, on the folder as Windows sees it (like the WSL terminal).
      const chatCwd = wslDistro ? toWindowsPath(wslDistro, cwd) : cwd;
      // The default distro (shell "wsl") has no name to compare: such a chat is never reused.
      const distroOf = (t: ChatTab) => {
        const shellDistro = wslDistroOfShell(t.shell);
        return shellDistro === null ? "\0wsl" : (shellDistro ?? wslDistroOfPath(t.cwd) ?? undefined);
      };
      // A chat tab already on this folder (same agent, profile, same side of WSL) shows it too, the conversation
      // it had keeps running in the background; only without one does a new tab open.
      const fits = (t: AppTab): t is ChatTab =>
        t.kind === "chat" && !t.delegate && t.agent === cli && t.cwd === chatCwd && (t.profileId ?? null) === (profileId ?? null) && !t.handoffFrom && distroOf(t) === (wslDistro || undefined);
      const target = all.find((t) => t.id === front && fits(t)) ?? all.find(fits);
      if (target) {
        showChatSession(target.id, sessionId, lastActiveAt);
        setActiveTabId(target.id);
        done();
        return;
      }
      // A session is loaded where it was saved (outside WSL or in its distro), whatever the default shell is.
      void openChatTab(cli, chatCwd, { profileId, shell: wslDistro ? wslShellId(wslDistro) : "host", resume: { sessionId, lastActiveAt } }).finally(done);
      return;
    }
    void openAgentSession(cwd, sessionId, cli, wslDistro, profileId).finally(done);
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
   * under: its login state is the one checked, and the dedicated dialog uses
   * that same profile. */
  async function ensureCliReady(cliBin: AgentCli, profileId?: string): Promise<boolean> {
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
      return openProviderAuth(cliBin, profileId);
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
    // The default agent view decides how a shortcut starts the agent: as a
    // chat it gets a tab of its own. Chat is host-only, so a WSL or ssh tab
    // keeps running it in the terminal.
    if (tab && defaultOpensChat() && tab.nestedShell !== "wsl" && tab.nestedShell !== "remote" && wslDistroOfShell(tabShell(tab)) === undefined) {
      // A plain idle host shell hands its place to the chat; anything else keeps its tab.
      const idle = !tab.busy && !tab.nestedShell;
      void openChatTab(cliBin, tab.cwd, { profileId: (wanted ?? tab.profileId) ?? undefined, replaceTabId: idle ? tabId : undefined });
      return;
    }
    if (await ensureCliReady(cliBin, tab?.profileId)) await launchInTab(cliBin, launchCommand, term, tabId);
  }

  /** Opens the dedicated provider dialog under this profile (Settings > Profiles). */
  async function loginProfile(profileId: string | null, cli: AgentCli) {
    // A login command for a CLI that isn't installed would only print "command
    // not found" in the terminal - offer the install instead.
    const installed = await invoke<{ installed: boolean }>("check_cli_status", { cli, profile: profileId })
      .then((s) => s.installed)
      .catch(() => true);
    if (!installed) {
      await offerCliInstall(cli);
      return;
    }
    await openProviderAuth(cli, profileId);
  }

  /** Starts `cli` in a NEW tab opened in `cwd` (the Agents panel's "+" menu: the
   * project folder). `shell` is the shell the
   * project's own tab runs. Uses the CLI plugin's command, which may carry the
   * user's flags. A WSL shell runs the distro's own CLI, so it skips the host
   * install check and the host-only flags, like `openAgentSession`. The new
   * tab runs under account profile `profileId` (default profile when
   * omitted) - ignored for WSL, where the env vars don't reach. Resolves to
   * whether the tab was opened (the CLI may be missing or signed out). Opens as
   * a chat tab when that is the default agent view (Settings > Agents), unless
   * `forceTerminal`. `at` is the strip index a plain (no `shell`) terminal tab
   * takes instead of the end. */
  async function launchAgentInNewTab(cli: AgentCli, cwd: string, shell?: string, profileId?: string, forceTerminal = false, at?: number): Promise<boolean> {
    let command = allPlugins.find((p) => cliOfPlugin(p.id) === cli)?.command ?? cli;
    if (wslDistroOfShell(shell) !== undefined) {
      const id = addTab(cwd, shell);
      pendingCommandsRef.current.set(id, command);
      return true;
    }
    // Opens in the default agent view; chat is host-only, so a WSL shell (above) never gets it.
    if (!forceTerminal && defaultOpensChat()) return openChatTab(cli, cwd, { profileId });
    if (!(await ensureCliReady(cli, profileId))) return false;
    if (cli === "vibe") await invoke("vibe_ensure_model", { profile: profileId ?? null }).catch(() => {});
    if (cli === "codex") command = await withCodexLaunchFlags(command);
    if (shell) {
      // addTab also activates the new tab.
      const id = addTab(cwd, shell, false, profileId ?? null);
      pendingCommandsRef.current.set(id, command);
      return true;
    }
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => insertTabAt(prev, makeTermTab(id, cwd, { profileId }), at));
    setActiveTabId(id);
    setActiveTerminalId(id);
    return true;
  }

  /** An agent picked on the new tab page: it starts in a new tab (see
   * `launchAgentInNewTab`) that takes the page's place, in its folder and
   * under its account profile (the folder's own project default, when the pick points elsewhere). The page stays if the agent can't start. */
  async function launchAgentFromNewTab(tabId: string, cli: AgentCli, cwd?: string, shell?: string) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab?.newTab) return;
    const startDir = cwd || tab.cwd || homeDir;
    // A folder other than the one the page showed (a recent, a favorite, a
    // folder found by search) may have its own project default profile -
    // unless the profile was picked on purpose (as `launchFromNewTab` does).
    const wsl = !!wslDistroOfPath(startDir) || wslDistroOfShell(shell) !== undefined;
    const lookup = !wsl && !!cwd && cwd !== tab.cwd && !explicitProfileRef.current.has(tabId);
    const profile = lookup ? ((await automaticProfile(tabId, startDir, false)) ?? tab.profileId) : tab.profileId;
    if (!(await launchAgentInNewTab(cli, startDir, shell, profile))) return;
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    forgetTab(tabId);
    setActiveTerminalId((active) => (active === tabId ? (latestRef.current.tabs.find((t) => t.kind === "terminal" && t.id !== tabId)?.id ?? "") : active));
  }

  /** Opens `cli` as a chat tab in `cwd` (the host file system), after the same
   * install/login check a terminal launch does. With `resume`, the tab resumes
   * that session (and takes its label) instead of starting a new one.
   * `replaceTabId` makes the chat take that terminal's place in the strip and
   * closes the terminal - only once the CLI is ready, so it stays otherwise;
   * `at` is the strip index to open at instead of the end. */
  async function openChatTab(
    cli: AgentCli,
    cwd: string,
    opts: OpenChatOptions = {},
  ): Promise<boolean> {
    const { profileId, viewId, resume, replaceTabId, at, shell, label, diagnosis, firstPrompt, background, onCreated } = opts;
    const inWsl = !!wslDistroOfPath(cwd) || wslDistroOfShell(shell) !== undefined;
    if (!inWsl && !(await ensureCliReady(cli, profileId))) return false;
    if (!inWsl && cli === "vibe") await invoke("vibe_ensure_model", { profile: profileId ?? null }).catch(() => {});
    const id = newTabId("chat");
    const tab: ChatTab = { kind: "chat", id, agent: cli, cwd, label: resume?.label ?? label ?? (basename(cwd) || CLI_INFO[cli].name), profileId, viewId: viewId ?? (defaultOpensChat() ? defaultAgentView() : undefined), shell: shell ?? getConfiguredShell(), sessionId: resume?.sessionId, handoffFrom: resume?.handoffFrom, talked: resume ? undefined : false, lastActiveAt: resume?.lastActiveAt, diagnosis, firstPrompt };
    setTabs((prev) => {
      const next = insertTabAt(prev, tab, replaceTabId ? prev.findIndex((t) => t.id === replaceTabId) : at);
      return replaceTabId ? next.filter((t) => t.id !== replaceTabId) : next;
    });
    // `background`: the tab opens behind the one in front (the browser's toast offers the way to it).
    if (!background) setActiveTabId(id);
    if (replaceTabId) dropTerminal(replaceTabId);
    onCreated?.(id);
    return true;
  }

  /** The folder (and shell) a chat or terminal opened for the browser starts in: the tab the page belongs to (the
   * terminal that printed its dev server, or the one it was opened for), else the tab in front, else the home. */
  function browserHintFolder(hintTabId?: string): { cwd: string; shell?: string } {
    const { tabs: all, activeTabId: front } = latestRef.current;
    const pick = (id: string | undefined) => {
      const tab = all.find((x) => x.id === id);
      if (tab?.kind === "terminal" && tab.cwd && !tab.newTab) return { cwd: tab.cwd, shell: tabShell(tab) };
      if (tab?.kind === "chat" && tab.cwd) return { cwd: tab.cwd, shell: tab.shell };
      return null;
    };
    return pick(hintTabId) ?? pick(front) ?? { cwd: homeDir };
  }

  /** Opens the chat of a task `parentTabId`'s agent delegated, in a tab next to its orchestrator's (and the ones of its other
   * delegates). The tab attaches to the child's running chat; opening the same task again brings its tab to the front. */
  function openDelegateTab(parentTabId: string, delegate: DelegateInfo, wslDistro: string | null) {
    const { tabs: all } = latestRef.current;
    const open = all.find((t) => t.kind === "chat" && t.delegate?.taskId === delegate.taskId);
    if (open) {
      setActiveTabId(open.id);
      return;
    }
    const found = all.find((t) => t.id === parentTabId);
    // The orchestrator is a chat or a terminal tab (whose agent delegated through Flowcode's MCP tools).
    const parent: DelegateParent | null =
      found?.kind === "chat"
        ? { id: found.id, cwd: found.cwd, shell: found.shell, profileId: found.profileId, agent: found.agent }
        : found?.kind === "terminal"
          ? { id: found.id, cwd: found.cwd, shell: tabShell(found) ?? "host", profileId: undefined, agent: null }
          : null;
    if (!parent) return;
    const known = (AGENT_CLIS as readonly string[]).includes(delegate.agent) ? (delegate.agent as AgentCli) : parent.agent;
    if (!known) return;
    const agent: AgentCli = known;
    // A finished child may be one the backend already let go (it keeps only the last few): a tab would attach to
    // nothing, so its saved conversation resumes as a chat instead.
    const sessionId = delegate.childSessionId;
    if (sessionId && delegate.status !== "running" && delegate.status !== "waiting_for_user") {
      void invoke("chat_events", { chatId: delegate.childChatId, afterSeq: Number.MAX_SAFE_INTEGER }).then(
        () => attachDelegateTab(parent, delegate, agent, wslDistro),
        () => {
          const holder = tabWithSession(sessionId);
          if (holder) openHistoryTab(holder.id, holder.kind === "chat" ? sessionId : undefined);
          else void openChatTab(agent, parent.cwd, { profileId: agent === parent.agent ? parent.profileId : undefined, shell: parent.shell, resume: { sessionId, label: delegate.title || undefined } });
        },
      );
      return;
    }
    attachDelegateTab(parent, delegate, agent, wslDistro);
  }

  /** The tab of `openDelegateTab`, attached to the child's running chat. */
  function attachDelegateTab(parent: DelegateParent, delegate: DelegateInfo, agent: AgentCli, wslDistro: string | null) {
    const parentTabId = parent.id;
    const { tabs: all } = latestRef.current;
    // Asked twice while the check above ran: one tab.
    const open = all.find((t) => t.kind === "chat" && t.delegate?.taskId === delegate.taskId);
    if (open) {
      setActiveTabId(open.id);
      return;
    }
    const id = newTabId("chat");
    const tab: ChatTab = {
      kind: "chat",
      id,
      agent,
      cwd: parent.cwd,
      label: delegate.title || CLI_INFO[agent].name,
      profileId: parent.profileId,
      shell: parent.shell,
      delegate: { chatId: delegate.childChatId, taskId: delegate.taskId, parentTabId, wslDistro },
    };
    // After the orchestrator and the delegate tabs already open next to it.
    const last = all.reduce((at, t, i) => (t.id === parentTabId || (t.kind === "chat" && t.delegate?.parentTabId === parentTabId) ? i : at), -1);
    setTabs((prev) => insertTabAt(prev, tab, last + 1 || undefined));
    setActiveTabId(id);
  }

  /** Per chat pane: callbacks whose identity never changes and that call the latest closures, so the memoized chat view skips App renders. */
  function stableChatCallbacks(key: string, latest: ChatCallbacks): ChatCallbacks {
    let entry = chatCallbacksRef.current.get(key);
    if (!entry) {
      const e = { latest, stable: {} as ChatCallbacks };
      const stable: Record<string, unknown> = {};
      for (const name of Object.keys(latest)) stable[name] = (...args: unknown[]) => (e.latest as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
      e.stable = stable as unknown as ChatCallbacks;
      entry = e;
      chatCallbacksRef.current.set(key, e);
    }
    entry.latest = latest;
    return entry.stable;
  }

  /** Ctrl+` in a chat: closes the chat (its view's unmount kills the agent, so
   * the session is free) and resumes that session in a terminal tab at the
   * chat's place. A null `sessionId` (no prompt sent yet: nothing on disk to
   * resume) starts a fresh agent there instead, and the chat stays if it
   * can't start. */
  function switchChatToTerminal(tab: ChatTab, sessionId: string | null, chatDistro?: string | null) {
    // Conversations parked in the background that are mid-turn end with the chat.
    const working = (latestRef.current.tabs.find((t): t is ChatTab => t.id === tab.id && t.kind === "chat")?.parked ?? []).filter((p) => p.status === "busy" || p.status === "waiting").length;
    if (working === 0) {
      doSwitchChatToTerminal(tab, sessionId, chatDistro);
      return;
    }
    void confirm({
      title: t("app.parkedBusy.title"),
      message: t("app.parkedBusy.message", { count: working }),
      confirmLabel: t("app.parkedBusy.confirm"),
      danger: true,
    }).then((ok) => {
      if (ok) doSwitchChatToTerminal(tab, sessionId, chatDistro);
    });
  }

  function doSwitchChatToTerminal(tab: ChatTab, sessionId: string | null, chatDistro?: string | null) {
    // A chat running in WSL keeps its sessions in the distro: the terminal is a WSL one there too.
    const distro = chatDistro || wslDistroOfShell(tab.shell) || null;
    const index = latestRef.current.tabs.findIndex((t) => t.id === tab.id);
    const at = index < 0 ? undefined : index;
    const dropChat = () => {
      setTabs((prev) => prev.filter((t) => t.id !== tab.id));
      forgetTab(tab.id);
    };
    // An id `openAgentSession` would refuse: the chat stays as it is rather than closing for nothing.
    if (sessionId && !isSafeSessionId(sessionId)) {
      console.warn("refusing to resume a session with an unexpected id", JSON.stringify(sessionId));
      return;
    }
    if (sessionId) {
      // The chat's agent is killed first and waited for: two processes must never share one session.
      // The tab stays in place meanwhile, so the terminal still takes its spot.
      // A second Ctrl+` while the first waits must not open a second terminal.
      if (switchingChatsRef.current.has(tab.id)) return;
      switchingChatsRef.current.add(tab.id);
      const closer = chatClosersRef.current.get(tab.paneKey ?? tab.id);
      void (async () => {
        try {
          await closer?.close();
          // A session with no transcript on disk (the only prompt failed before it was saved) can't be resumed:
          // `claude --resume` / `codex resume` would just say it isn't found, so a fresh agent starts instead.
          // Not checked for WSL: its transcripts are in the distro, out of this check's reach (the chat was used, so it has one).
          const saved = distro ? true : await invoke<boolean>("agent_session_saved", { cli: tab.agent, sessionId, profile: tab.profileId ?? null }).catch(() => true);
          if (saved) {
            dropChat();
            await openAgentSession(distro ? (toWslPath(distro, tab.cwd) ?? tab.cwd) : tab.cwd, sessionId, tab.agent, distro ?? undefined, tab.profileId, at);
          } else if (await launchAgentInNewTab(tab.agent, tab.cwd, undefined, tab.profileId, true, at)) {
            dropChat();
          } else {
            // The chat's agent is gone and no terminal took over: the chat starts again.
            closer?.restart();
          }
        } finally {
          switchingChatsRef.current.delete(tab.id);
        }
      })();
      return;
    }
    // The chat's agent ends first (two Codex processes starting together trip over their state store); the fresh terminal then
    // goes in front of the chat, which closes.
    if (switchingChatsRef.current.has(tab.id)) return;
    switchingChatsRef.current.add(tab.id);
    const freshCloser = chatClosersRef.current.get(tab.paneKey ?? tab.id);
    void (async () => {
      try {
        await freshCloser?.close();
        if (await launchAgentInNewTab(tab.agent, tab.cwd, distro ? wslShellId(distro) : undefined, tab.profileId, true, at)) dropChat();
        else freshCloser?.restart();
      } finally {
        switchingChatsRef.current.delete(tab.id);
      }
    })();
  }

  /** The reverse of `switchChatToTerminal`: resumes the session in a chat tab.
   * The terminal's agent is ended first and waited for (two processes must
   * never share one session); the terminal tab stays, at its shell prompt,
   * until the chat has loaded (`finishHandoff`) and closes it. If the chat
   * can't, the session is resumed back in that terminal. Only host agents
   * whose session id is known, and not while the agent is busy. */
  function switchTerminalToChat(tabId: string, viewId?: string) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const session = S.sessionByTab.get(tabId);
    if (!tab || !session || session.status === "busy" || session.wsl_distro || !(AGENT_CLIS as readonly string[]).includes(session.cli)) return;
    // A second trigger while the agent is still being ended must not open a second chat.
    if (switchingChatsRef.current.has(tabId)) return;
    switchingChatsRef.current.add(tabId);
    const cli = session.cli as AgentCli;
    const sessionId = session.session_id;
    void (async () => {
      try {
        // An agent nobody prompted yet has no transcript to load (the chat would fail and the terminal be
        // sent back to a `--resume` that finds nothing): a fresh chat takes the terminal's place instead.
        // Codex has no thread at all until its first prompt: nothing to resume either.
        const saved = sessionId ? await invoke<boolean>("agent_session_saved", { cli, sessionId, profile: tab.profileId ?? session.profile ?? null }).catch(() => true) : false;
        if (!saved || !sessionId) {
          const at = latestRef.current.tabs.findIndex((t) => t.id === tabId);
          await openChatTab(cli, session.cwd ?? tab.cwd, { profileId: tab.profileId ?? session.profile ?? undefined, viewId, replaceTabId: tabId, shell: "host", at: at < 0 ? undefined : at });
          return;
        }
        // The terminal's agent was just in use.
        const resume = { sessionId, label: tab.label, handoffFrom: tabId, lastActiveAt: Date.now() };
        const ptyId = termRefs.current.get(tabId)?.getPtyId();
        if (ptyId) await invoke("end_pty_agent", { ptyId }).catch(() => {});
        // Opens at the terminal's index, so the chat sits where the terminal was once that closes.
        const at = latestRef.current.tabs.findIndex((t) => t.id === tabId);
        const opened = await openChatTab(cli, session.cwd ?? tab.cwd, { profileId: tab.profileId ?? session.profile ?? undefined, viewId, resume, shell: "host", at: at < 0 ? undefined : at });
        if (!opened) resumeInTerminal(tabId, cli, sessionId);
      } finally {
        switchingChatsRef.current.delete(tabId);
      }
    })();
  }

  /** Resumes `sessionId` again in terminal tab `tabId`, whose agent a handoff ended: the shell is back at its prompt. */
  function resumeInTerminal(tabId: string, cli: AgentCli, sessionId: string) {
    void resumeCommand(cli, sessionId, true, (latestRef.current.tabs.find((t) => t.id === tabId && t.kind === "terminal") as TermTab | undefined)?.profileId ?? undefined).then((command) => termRefs.current.get(tabId)?.runCommandSilently(command));
  }

  /** The chat resumed the session: the terminal it took over closes. */
  function finishHandoff(chatId: string, terminalId: string) {
    patchChatTab(chatId, { handoffFrom: undefined });
    setTabs((prev) => prev.filter((t) => t.id !== terminalId));
    dropTerminal(terminalId);
  }

  /** The chat couldn't resume the session: it goes away and the terminal resumes it again. */
  function failHandoff(chatId: string, error?: string | null) {
    const chat = latestRef.current.tabs.find((t): t is ChatTab => t.id === chatId && t.kind === "chat");
    const terminalId = chat?.handoffFrom;
    setTabs((prev) => prev.filter((t) => t.id !== chatId));
    forgetTab(chatId);
    if (terminalId && latestRef.current.tabs.some((t) => t.id === terminalId)) {
      setActiveTabId(terminalId);
      // The terminal's agent was ended for the handoff: it gets its session back.
      if (chat.sessionId && isSafeSessionId(chat.sessionId)) resumeInTerminal(terminalId, chat.agent, chat.sessionId);
    }
    // Why, when the agent said (Codex: the session is still in use elsewhere): not a silent failure.
    const detail = (error ?? "").replace(/^`[^`]*`:\s*/, "").replace(/^[a-z_]+:\s*/, "").trim().slice(0, 200);
    showPluginToast(detail ? `${t("agents.handoff.failed")} ${detail}` : t("agents.handoff.failed"));
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
  return {
    resumeAgentSession, checkCliAndMaybeLaunch, loginProfile, launchAgentInNewTab, launchAgentFromNewTab,
    openChatTab, browserHintFolder, openDelegateTab, stableChatCallbacks, switchChatToTerminal,
    switchTerminalToChat, finishHandoff, failHandoff,
  };
}
