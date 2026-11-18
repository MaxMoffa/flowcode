import type { AppTab, ChatPane, ChatTab } from "./types";
import { newTabId } from "./tabId";
import { basename } from "../lib/path";
import { CLI_INFO } from "../agents/cliInfo";

/** Patches a chat tab's fields as its view reports them. */
export function patchChatTab(tabs: AppTab[], id: string, patch: Partial<ChatTab>): AppTab[] {
  return tabs.map((t) => (t.id === id && t.kind === "chat" ? { ...t, ...patch } : t));
}

/** Patches one conversation of a chat tab: the shown one lives on the tab, a parked one in `parked`. */
export function patchChatPane(tabs: AppTab[], tabId: string, paneKey: string, patch: Partial<ChatPane>): AppTab[] {
  return tabs.map((t) => {
    if (t.id !== tabId || t.kind !== "chat") return t;
    if ((t.paneKey ?? t.id) === paneKey) return { ...t, ...patch };
    return t.parked ? { ...t, parked: t.parked.map((p) => (p.paneKey === paneKey ? { ...p, ...patch } : p)) } : t;
  });
}

/** `next` becomes the conversation shown in chat tab `t`; the one shown until now is parked, its agent keeps running. */
export function swapChatPane(t: ChatTab, next: ChatPane): ChatTab {
  const current: ChatPane = { paneKey: t.paneKey ?? t.id, label: t.label, sessionId: t.sessionId, viewId: t.viewId, status: t.status, talked: t.talked, lastActiveAt: t.lastActiveAt };
  return {
    ...t,
    paneKey: next.paneKey,
    label: next.label,
    sessionId: next.sessionId,
    viewId: next.viewId,
    status: next.status,
    talked: next.talked,
    lastActiveAt: next.lastActiveAt,
    parked: [...(t.parked ?? []).filter((p) => p.paneKey !== next.paneKey), current],
  };
}

/** Shows `sessionId` in chat tab `tabId`: a parked conversation of it is swapped in, otherwise a new one
 * starts resuming it. */
export function showChatSession(tabs: AppTab[], tabId: string, sessionId: string, lastActiveAt?: number): AppTab[] {
  return tabs.map((t) => {
    if (t.id !== tabId || t.kind !== "chat" || t.sessionId === sessionId) return t;
    const found = t.parked?.find((p) => p.sessionId === sessionId);
    return swapChatPane(t, found ?? { paneKey: newTabId("chat"), label: basename(t.cwd) || CLI_INFO[t.agent].name, sessionId, viewId: t.viewId, lastActiveAt });
  });
}

/** Starts a fresh conversation in chat tab `tabId`, beside the one shown (which keeps running in the background). */
export function newChatPane(tabs: AppTab[], tabId: string): AppTab[] {
  return tabs.map((t) => (t.id === tabId && t.kind === "chat" ? swapChatPane(t, { paneKey: newTabId("chat"), label: basename(t.cwd) || CLI_INFO[t.agent].name, viewId: t.viewId, talked: false }) : t));
}
