import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n";
import type { AgentViewDef } from "./types";

/** The view a chat opens with, and the fallback for an id nobody registers. */
export const DEFAULT_ACP_VIEW = "chat";

/** An ordered list of views: the order is the one the session menu shows. */
export function createRegistry() {
  // Replaced, never mutated: `list` is a snapshot React can compare.
  let views: readonly AgentViewDef[] = [];
  const listeners = new Set<() => void>();

  function change(next: readonly AgentViewDef[]) {
    views = next;
    listeners.forEach((listener) => listener());
  }

  function register(def: AgentViewDef) {
    if (views.some((v) => v.id === def.id)) throw new Error(`Agent view already registered: ${def.id}`);
    change([...views, def]);
  }

  /** Removes an installed view; a built-in one stays. */
  function unregister(id: string) {
    if (views.some((v) => v.id === id && v.source === "plugin")) change(views.filter((v) => v.id !== id));
  }

  function get(id: string | undefined): AgentViewDef | undefined {
    return views.find((v) => v.id === id);
  }

  /** The acp view with this id, or the default one: a view id saved in a
   * session may belong to a plugin uninstalled since. */
  function resolveAcp(id?: string): AgentViewDef {
    const found = get(id);
    if (found?.transport === "acp") return found;
    const fallback = get(DEFAULT_ACP_VIEW);
    if (!fallback) throw new Error(`Default agent view not registered: ${DEFAULT_ACP_VIEW}`);
    return fallback;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { register, unregister, list: () => views, get, resolveAcp, subscribe };
}

const registry = createRegistry();

export const registerAgentView = registry.register;
export const unregisterAgentView = registry.unregister;
export const agentViews = registry.list;
export const agentView = registry.get;
export const resolveAcpView = registry.resolveAcp;

/** The registered views, kept current as plugin views are installed and removed. */
export function useAgentViews(): readonly AgentViewDef[] {
  return useSyncExternalStore(registry.subscribe, registry.list);
}

/** The name a view goes by in the menu, in the UI language. */
export function viewLabel(def: AgentViewDef, t: (key: MessageKey) => string, language: string): string {
  return def.labels?.[language] ?? def.label ?? (def.labelKey ? t(def.labelKey) : def.id);
}
