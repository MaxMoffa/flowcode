import { useMemo } from "react";
import { createStore } from "../lib/externalStore";
import type { AgentCli } from "../agents/cliInfo";

export type CallKind = "permission" | "question" | "browser" | "done" | "attention" | "custom";

export interface CallOption {
  id: string;
  label: string;
  hint?: string;
  tone?: "primary" | "danger" | "default";
}

/** An agent in a tab other than the one on screen that needs the user: shown as a bubble under its tab (see CallBubble). */
export interface AgentCall {
  id: string;
  tabId: string;
  agent?: AgentCli;
  kind: CallKind;
  title: string;
  detail?: string;
  command?: string;
  createdAt: number;
  /** Inline answers to a permission or a choice question. */
  options?: CallOption[];
  onOption?: (optionId: string) => void;
  /** A free-text answer to a question. */
  onReply?: (text: string) => void;
  /** Browser pages: show it in the tab on screen instead of going to the agent's tab. */
  onOpenHere?: () => void;
  /** Same key replaces: a request that is raised again must not stack up. */
  key?: string;
}

export type NewCall = Omit<AgentCall, "id" | "createdAt"> & { id?: string; createdAt?: number };

/** A "done" call is only news for a moment. */
export const DONE_CALL_TTL_MS = 20_000;

/** Kinds that mirror something still waiting for an answer: whoever raised them removes them when it is settled, so
 * going to the tab (and leaving it again) must not lose them. */
const PENDING_KINDS: readonly CallKind[] = ["permission", "question"];

interface CallState {
  calls: AgentCall[];
  focusTab: string | null;
}

const store = createStore<CallState>({ calls: [], focusTab: null });

let nextId = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function forget(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export const getCalls = () => visible(store.get());

function visible({ calls, focusTab }: CallState): AgentCall[] {
  return calls.filter((c) => c.tabId !== focusTab).sort((a, b) => b.createdAt - a.createdAt);
}

/** The calls to show, newest first: never the ones of the tab on screen. */
export function useCalls(): AgentCall[] {
  const state = store.use();
  return useMemo(() => visible(state), [state]);
}

/** Adds a call (replacing the one with the same key) and returns its id. */
export function addCall(call: NewCall): string {
  const id = call.id ?? `call-${++nextId}`;
  const full: AgentCall = { ...call, id, createdAt: call.createdAt ?? Date.now() };
  // Nobody needs calling about the tab they are looking at (a pending request is kept: they may leave it still unanswered).
  if (full.tabId === store.get().focusTab && !PENDING_KINDS.includes(full.kind)) return id;
  store.update((s) => {
    const replaced = full.key ? s.calls.find((c) => c.key === full.key) : undefined;
    if (replaced) forget(replaced.id);
    return { ...s, calls: [...s.calls.filter((c) => c !== replaced), full] };
  });
  if (full.kind === "done") timers.set(id, setTimeout(() => removeCall(id), DONE_CALL_TTL_MS));
  return id;
}

export function removeCall(id: string) {
  forget(id);
  if (store.get().calls.some((c) => c.id === id)) store.update((s) => ({ ...s, calls: s.calls.filter((c) => c.id !== id) }));
}

export function removeCallByKey(key: string) {
  const call = store.get().calls.find((c) => c.key === key);
  if (call) removeCall(call.id);
}

/** Drops every call of a tab (it was closed). */
export function clearTab(tabId: string) {
  store.get().calls.filter((c) => c.tabId === tabId).forEach((c) => forget(c.id));
  store.update((s) => ({ ...s, calls: s.calls.filter((c) => c.tabId !== tabId) }));
}

/** The tab on screen changed: what it called about is moot now, except the requests still waiting for an answer. */
export function setCallFocusTab(tabId: string | null) {
  const stale = store.get().calls.filter((c) => c.tabId === tabId && !PENDING_KINDS.includes(c.kind));
  stale.forEach((c) => forget(c.id));
  store.update((s) => ({ focusTab: tabId, calls: stale.length ? s.calls.filter((c) => !stale.includes(c)) : s.calls }));
}

/** For tests. */
export function resetCalls() {
  timers.forEach(clearTimeout);
  timers.clear();
  store.set({ calls: [], focusTab: null });
}
