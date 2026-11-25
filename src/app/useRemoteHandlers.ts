import { useRef } from "react";
import type { ChatTab } from "../tabs/types";
import { wslDistroOfPath, wslShellId } from "../terminal/wslPath";
import { isPhoneAction } from "../plugins/remotePublish";
import { profileForPath } from "../profiles/profiles";
import { useRemoteWindowEvents, type RemoteTabOp } from "./useRemoteWindowEvents";
import { listedTabs } from "../tabs/tabState";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import type { ShellCtx } from "./shellContext";

/** What a paired phone (or another PC) asks this window to do: kept current each render for the long-lived listeners. */
export function useRemoteHandlers(S: ShellCtx) {
  const {
    addTab, adoptTabRef, allPlugins, closeTab, duplicateTab, homeDir, latestRef, launchAgentInNewTab, loginProfile,
    openChatTab, pendingRemoteRunRef, profiles, quickActionIds, renameTab, reorderTab, resumeAgentSession,
    runPlugin, selectTabRef, switchChatToTerminal, switchTerminalToChat, termRefs, toggleTabNotifications,
  } = S;
  // The phone-triggered action runner and what it needs, kept current each
  // render for the long-lived "remote://run-action" listener.
  const remoteActionRef = useRef<(id: string, ptyId: string | null) => void>(() => {});
  /** The phone asked to sign a CLI in under a profile (see loginProfile). */
  const remoteProfileLoginRef = useRef<(profileId: string | null, cli: string) => void>(() => {});
  /** The phone asked for a new terminal tab (see useRemoteWindowEvents). */
  const remoteNewTabRef = useRef<(cwd: string | null, cli: string | null, profile: string | null | undefined) => void>(() => {});
  const remoteRenameRef = useRef<(ptyId: string, label: string) => void>(() => {});
  const remoteCloseRef = useRef<(ptyId: string) => void>(() => {});
  /** The phone asked to hand a chat tab over to a terminal / for a new chat tab. */
  const remoteChatTerminalRef = useRef<(tabId: string) => void>(() => {});
  const remoteTerminalChatRef = useRef<(ptyId: string) => void>(() => {});
  const remoteChatRenameRef = useRef<(tabId: string, label: string) => void>(() => {});
  const remoteChatCloseRef = useRef<(tabId: string) => void>(() => {});
  const remoteTabOpRef = useRef<(target: { ptyId?: string; tabId?: string }, op: RemoteTabOp) => void>(() => {});
  const remoteNewChatRef = useRef<(cwd: string | null, cli: string, profile: string | null | undefined) => void>(() => {});
  const remoteResumeRef = useRef<(cwd: string, sessionId: string, cli: string, wslDistro: string | null | undefined, profile: string | null | undefined, view?: "chat" | "terminal") => void>(() => {});

  useRemoteWindowEvents({
    adoptTabRef,
    selectTabRef,
    latestRef,
    termRefs,
    remoteActionRef,
    remoteProfileLoginRef,
    remoteNewTabRef,
    remoteRenameRef,
    remoteCloseRef,
    remoteChatTerminalRef,
    remoteTerminalChatRef,
    remoteChatRenameRef,
    remoteChatCloseRef,
    remoteTabOpRef,
    remoteNewChatRef,
    remoteResumeRef,
  });

  remoteProfileLoginRef.current = (profileId, cli) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    void loginProfile(profileId, cli as AgentCli);
  };

  /** A profile id from the phone: "" = the default profile, an unknown id falls back to it, absent = automatic. */
  function remoteProfileId(profile: string | null | undefined): string | null | undefined {
    return profile == null ? undefined : profiles.some((p) => p.id === profile) ? profile : null;
  }

  remoteNewTabRef.current = (cwd, cli, profile) => {
    const profileId = remoteProfileId(profile);
    if (cli && (AGENT_CLIS as readonly string[]).includes(cli)) {
      const dir = cwd ?? homeDir;
      // Automatic for an agent: the folder's project default, like a shell tab gets.
      const pick = profileId !== undefined ? Promise.resolve(profileId) : profileForPath(dir);
      // The phone picks terminal or chat itself (its own default view).
      const distro = wslDistroOfPath(dir);
      void pick.then((id) => launchAgentInNewTab(cli as AgentCli, dir, distro ? wslShellId(distro) : undefined, id ?? undefined, true));
    } else addTab(cwd ?? undefined, undefined, false, profileId);
  };

  remoteResumeRef.current = (cwd, sessionId, cli, wslDistro, profile, view) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    resumeAgentSession(cwd, sessionId, cli as AgentCli, wslDistro ?? undefined, remoteProfileId(profile) ?? undefined, undefined, view);
  };

  remoteNewChatRef.current = (cwd, cli, profile) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    const profileId = remoteProfileId(profile);
    const dir = cwd ?? homeDir;
    const pick = profileId !== undefined ? Promise.resolve(profileId) : profileForPath(dir);
    void pick.then((id) => openChatTab(cli as AgentCli, dir, { profileId: id ?? undefined }));
  };

  remoteChatTerminalRef.current = (tabId) => {
    const tab = latestRef.current.tabs.find((t): t is ChatTab => t.id === tabId && t.kind === "chat");
    // Not mid-turn: the terminal would resume a session the agent is still writing (the desktop's own Ctrl+` refuses it too).
    if (!tab || tab.status === "busy" || tab.status === "waiting" || tab.status === "starting") return;
    // `talked === false`: nothing was said, so there is no session to resume.
    if (tab.talked === false || tab.sessionId) switchChatToTerminal(tab, tab.talked === false ? null : (tab.sessionId ?? null));
  };

  remoteTerminalChatRef.current = (ptyId) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    if (tabId) switchTerminalToChat(tabId);
  };
  remoteChatRenameRef.current = (tabId, label) => {
    if (latestRef.current.tabs.some((t) => t.id === tabId && t.kind === "chat")) renameTab(tabId, label);
  };
  remoteChatCloseRef.current = (tabId) => {
    // Closing the window's last tab would close the window: not from afar.
    if (latestRef.current.tabs.length > 1 && latestRef.current.tabs.some((t) => t.id === tabId && t.kind === "chat")) void closeTab(tabId);
  };
  remoteRenameRef.current = (ptyId, label) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    if (tabId) renameTab(tabId, label);
  };
  remoteTabOpRef.current = (target, op) => {
    let tabId = target.tabId;
    if (target.ptyId) {
      for (const [id, h] of termRefs.current) {
        if (h.getPtyId() === target.ptyId) tabId = id;
      }
    }
    const tab = tabId ? latestRef.current.tabs.find((t) => t.id === tabId) : undefined;
    if (!tab || (tab.kind !== "terminal" && tab.kind !== "chat")) return;
    if (op.kind === "duplicate") {
      // Same rule as the tab menu: a delegated child's view has no agent of its own to start again.
      if (tab.kind === "terminal" || !tab.delegate) duplicateTab(tab.id);
    } else if (op.kind === "notify") {
      if (tab.kind === "terminal" && !!tab.notifyMuted === op.on) toggleTabNotifications(tab.id);
    } else if (op.kind === "move") {
      // `index` counts the strip's listed tabs; reorderTab works on all of them.
      const strip = listedTabs(latestRef.current.tabs);
      const dest = strip[Math.min(op.index, strip.length - 1)];
      const to = dest ? latestRef.current.tabs.findIndex((t) => t.id === dest.id) : -1;
      if (to !== -1) reorderTab(tab.id, to);
    }
  };
  remoteCloseRef.current = (ptyId) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    // Closing the window's last tab would close the window: not from a phone.
    if (tabId && latestRef.current.tabs.length > 1) void closeTab(tabId);
  };
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
}
