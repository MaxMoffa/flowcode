import { createStore } from "../lib/externalStore";
import type { ChatTaskInfo, DelegateInfo, DelegateRequest } from "./chatModel";

/** What a chat tab's conversation knows about delegation, published for the agents panel (which sits far from the chat). */
export interface TabDelegation {
  /** Tasks this chat's agent handed to others, in the order they started. */
  delegates: DelegateInfo[];
  /** The delegates' open requests, oldest first. */
  requests: DelegateRequest[];
  /** Set on a delegated child: what it was asked. */
  task: ChatTaskInfo | null;
  /** The distro the chat runs in, for opening a delegate's tab. */
  wslDistro: string | null;
  /** The chat's agent is gone (exited, failed to start): its children went with it. */
  ended: boolean;
}

const sameList = <T extends object>(a: T[], b: T[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    const keys = Object.keys(x) as (keyof T)[];
    return x === y || (keys.length === Object.keys(y).length && keys.every((k) => Object.is(x[k], y[k])));
  });

/** Whether two snapshots say the same (the model rebuilds the arrays on every event). */
export function sameDelegation(a: TabDelegation, b: TabDelegation): boolean {
  return a.wslDistro === b.wslDistro && a.ended === b.ended && sameList(a.delegates, b.delegates) && a.requests.length === b.requests.length && a.requests.every((r, i) => r.requestId === b.requests[i].requestId && r.childChatId === b.requests[i].childChatId) && a.task?.taskId === b.task?.taskId;
}

const NONE: TabDelegation = { delegates: [], requests: [], task: null, wslDistro: null, ended: false };
const store = createStore<Record<string, TabDelegation>>({});

/** Publishes (or, with null, withdraws) the delegation state of a tab's chat. */
export function publishTabDelegation(tabId: string, value: TabDelegation | null) {
  const all = store.get();
  const prev = all[tabId];
  if (value === null) {
    if (!prev) return;
    const { [tabId]: _gone, ...rest } = all;
    store.set(rest);
    return;
  }
  if (prev && sameDelegation(prev, value)) return;
  store.set({ ...all, [tabId]: value });
}

/** The delegation state of a tab's chat; empty when the tab publishes none. */
export function useTabDelegation(tabId: string | null): TabDelegation {
  const all = store.use();
  return (tabId && all[tabId]) || NONE;
}

/** Every tab's published delegation state. */
export function useAllTabDelegations(): Record<string, TabDelegation> {
  return store.use();
}

/** The delegate tabs whose child is no longer one of its orchestrator's: the orchestrator's chat ended, was cleared or restarted, or its tab no longer shows a chat. */
export function staleDelegateTabs(tabs: { id: string; delegate?: { chatId: string; parentTabId: string } }[], all: Record<string, TabDelegation>): string[] {
  return tabs.flatMap((t) => {
    if (!t.delegate) return [];
    const parent = all[t.delegate.parentTabId];
    const { chatId } = t.delegate;
    return !parent || parent.ended || !parent.delegates.some((d) => d.childChatId === chatId) ? [t.id] : [];
  });
}
