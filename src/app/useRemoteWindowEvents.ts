// Window events other windows (tab moves, the Agents panel) and the
// remote-access server (phone requests) send this one. Subscribed once for
// the window's life, so every input is a ref that always holds the latest.
import { useEffect, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { TerminalHandle } from "../terminal/Terminal";
import type { AppTab } from "../tabs/types";
import type { TabTransfer } from "../tabs/transfer";
import { noteRemoteSubmit } from "../terminal/ptyClient";

const appWindow = getCurrentWindow();

interface RemoteWindowEventRefs {
  adoptTabRef: MutableRefObject<(transfer: TabTransfer) => void>;
  selectTabRef: MutableRefObject<(id: string) => void>;
  latestRef: MutableRefObject<{ tabs: AppTab[] }>;
  termRefs: MutableRefObject<Map<string, TerminalHandle>>;
  remoteActionRef: MutableRefObject<(id: string, ptyId: string | null) => void>;
  remoteProfileLoginRef: MutableRefObject<(profileId: string | null, cli: string) => void>;
  remoteNewTabRef: MutableRefObject<(cwd: string | null, cli: string | null, profile: string | null | undefined) => void>;
  remoteRenameRef: MutableRefObject<(ptyId: string, label: string) => void>;
  remoteCloseRef: MutableRefObject<(ptyId: string) => void>;
  remoteChatTerminalRef: MutableRefObject<(tabId: string) => void>;
  remoteTerminalChatRef: MutableRefObject<(ptyId: string) => void>;
  remoteChatRenameRef: MutableRefObject<(tabId: string, label: string) => void>;
  remoteChatCloseRef: MutableRefObject<(tabId: string) => void>;
  remoteNewChatRef: MutableRefObject<(cwd: string | null, cli: string, profile: string | null | undefined) => void>;
}

export function useRemoteWindowEvents(refs: RemoteWindowEventRefs) {
  useEffect(() => {
    const { adoptTabRef, selectTabRef, latestRef, termRefs, remoteActionRef, remoteProfileLoginRef, remoteNewTabRef, remoteRenameRef, remoteCloseRef, remoteChatTerminalRef, remoteTerminalChatRef, remoteChatRenameRef, remoteChatCloseRef, remoteNewChatRef } = refs;
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
    const unlistenLogin = webview.listen<{ id?: string | null; cli?: string }>("remote://profile-login", (e) => {
      // An empty id is the default profile.
      if (e.payload.cli) remoteProfileLoginRef.current(e.payload.id || null, e.payload.cli);
    });
    // A phone asking for a new terminal tab here.
    const unlistenNewTab = webview.listen<{ cwd?: string | null; cli?: string | null; profile?: string | null }>("remote://new-tab", (e) => {
      remoteNewTabRef.current(e.payload.cwd ?? null, e.payload.cli ?? null, e.payload.profile ?? undefined);
    });
    // A phone renaming one of our terminal tabs.
    const unlistenRename = webview.listen<{ ptyId: string; label: string }>("remote://rename-tab", (e) =>
      remoteRenameRef.current(e.payload.ptyId, e.payload.label),
    );
    // A phone closing one of our terminal tabs.
    const unlistenClose = webview.listen<{ ptyId: string }>("remote://close-tab", (e) => remoteCloseRef.current(e.payload.ptyId));
    // A phone handing one of our chats over to a terminal tab.
    const unlistenChatTerminal = webview.listen<{ tabId: string }>("remote://chat-terminal", (e) => remoteChatTerminalRef.current(e.payload.tabId));
    // A phone reopening one of our agent terminals as a chat.
    const unlistenTerminalChat = webview.listen<{ ptyId: string }>("remote://terminal-chat", (e) => remoteTerminalChatRef.current(e.payload.ptyId));
    // A phone renaming one of our chat tabs.
    const unlistenChatRename = webview.listen<{ tabId: string; label: string }>("remote://chat-rename", (e) =>
      remoteChatRenameRef.current(e.payload.tabId, e.payload.label),
    );
    // A phone (or another PC) closing one of our chat tabs.
    const unlistenChatClose = webview.listen<{ tabId: string }>("remote://chat-close", (e) => remoteChatCloseRef.current(e.payload.tabId));
    // A phone asking for a new chat tab here.
    const unlistenNewChat = webview.listen<{ cwd?: string | null; cli: string; profile?: string | null }>("remote://new-chat", (e) => {
      remoteNewChatRef.current(e.payload.cwd ?? null, e.payload.cli, e.payload.profile ?? undefined);
    });
    // A prompt sent from a phone: counts as a submit for the agent notifications.
    const unlistenSubmit = webview.listen<string>("remote://submit", (e) => noteRemoteSubmit(e.payload));
    return () => {
      unlisten.then((off) => off());
      unlistenFocus.then((off) => off());
      unlistenSnap.then((off) => off());
      unlistenSize.then((off) => off());
      unlistenAction.then((off) => off());
      unlistenLogin.then((off) => off());
      unlistenNewTab.then((off) => off());
      unlistenRename.then((off) => off());
      unlistenClose.then((off) => off());
      unlistenChatTerminal.then((off) => off());
      unlistenTerminalChat.then((off) => off());
      unlistenChatRename.then((off) => off());
      unlistenChatClose.then((off) => off());
      unlistenNewChat.then((off) => off());
      unlistenSubmit.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
