import { createStore } from "../lib/externalStore";
import { readJson, writeJson } from "../lib/storage";

/** A conversation an orchestrator's agent delegated: kept so the History lists it under its orchestrator, also after a restart. */
export interface DelegateChild {
  /** The child's own agent session: what resuming it as a normal chat needs. */
  childSessionId: string;
  agent: string;
  title: string;
  /** The backend's task status (`running`, `waiting_for_user`, `done`, `failed`, `cancelled`). */
  status: string;
  taskId: string;
}

/** Orchestrator session id -> its delegated children, with when it last changed (for the cap). */
export type DelegateHistory = Record<string, { at: number; children: DelegateChild[] }>;

const MAX_ORCHESTRATORS = 200;
const KEY = "flowcode.delegateHistory";

const isChild = (v: unknown): v is DelegateChild => {
  const c = v as Partial<DelegateChild> | null;
  return !!c && typeof c.childSessionId === "string" && typeof c.agent === "string" && typeof c.title === "string" && typeof c.status === "string" && typeof c.taskId === "string";
};

const isHistory = (v: unknown): v is DelegateHistory =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((e) => typeof e === "object" && e !== null && typeof (e as { at?: unknown }).at === "number" && Array.isArray((e as { children?: unknown }).children) && (e as { children: unknown[] }).children.every(isChild));

const sameChild = (a: DelegateChild, b: DelegateChild) =>
  a.childSessionId === b.childSessionId && a.agent === b.agent && a.title === b.title && a.status === b.status && a.taskId === b.taskId;

/** Adds or updates `children` (by task) under an orchestrator, dropping the least recently changed orchestrators beyond `cap`. Returns `history` itself when nothing changed. */
export function mergeChildren(history: DelegateHistory, orchestratorId: string, children: DelegateChild[], now: number, cap = MAX_ORCHESTRATORS): DelegateHistory {
  const known = history[orchestratorId]?.children ?? [];
  const next = [...known];
  let changed = false;
  for (const child of children) {
    const at = next.findIndex((c) => c.taskId === child.taskId);
    if (at < 0) {
      next.push(child);
      changed = true;
    } else if (!sameChild(next[at], child)) {
      next[at] = child;
      changed = true;
    }
  }
  if (!changed) return history;
  const merged: DelegateHistory = { ...history, [orchestratorId]: { at: now, children: next } };
  const ids = Object.keys(merged);
  if (ids.length <= cap) return merged;
  const keep = new Set(ids.sort((a, b) => merged[b].at - merged[a].at).slice(0, cap));
  return Object.fromEntries(Object.entries(merged).filter(([id]) => keep.has(id)));
}

/** After a restart nothing runs any more: a task stored as running or waiting was cut short. */
export function markInterrupted(history: DelegateHistory): DelegateHistory {
  return Object.fromEntries(
    Object.entries(history).map(([id, e]) => [id, { ...e, children: e.children.map((c) => (c.status === "running" || c.status === "waiting_for_user" ? { ...c, status: "cancelled" } : c)) }]),
  );
}

/** `agent:sessionId` of every known child: those are not conversations of their own in the History. */
export function childKeys(history: DelegateHistory): Set<string> {
  const keys = new Set<string>();
  for (const e of Object.values(history)) for (const c of e.children) keys.add(`${c.agent}:${c.childSessionId}`);
  return keys;
}

const store = createStore<DelegateHistory>(markInterrupted(readJson<DelegateHistory>(KEY, isHistory, {})));

export const useDelegateHistory = store.use;
export const getDelegateHistory = store.get;

/** Settle this session's live children when its chat is reset or unmounted before final events reach the UI. */
export function interruptDelegates(orchestratorId: string) {
  const children = store.get()[orchestratorId]?.children;
  if (!children) return;
  recordDelegates(orchestratorId, children.map((child) =>
    child.status === "running" || child.status === "waiting_for_user" ? { ...child, status: "cancelled" } : child,
  ));
}

/** Notes the delegates of an orchestrator's session (the ones that already have a session of their own). */
export function recordDelegates(orchestratorId: string, delegates: { taskId: string; agent: string; title: string; status: string; childSessionId?: string }[]) {
  const children: DelegateChild[] = [];
  for (const d of delegates) if (d.childSessionId) children.push({ childSessionId: d.childSessionId, agent: d.agent, title: d.title, status: d.status, taskId: d.taskId });
  if (children.length === 0) return;
  const next = mergeChildren(store.get(), orchestratorId, children, Date.now());
  if (next === store.get()) return;
  store.set(next);
  writeJson(KEY, next);
}
