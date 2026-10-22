import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n";
import type { NewTabLayoutDef } from "./types";

/** The layout a new tab opens on until the user picks another, and the
 * fallback for an id nobody registers. */
export const DEFAULT_NEW_TAB_LAYOUT = "terminal";

/** An ordered list of layouts: the order is the one the customize panel shows. */
export function createLayoutRegistry() {
  // Replaced, never mutated: `list` is a snapshot React can compare.
  let layouts: readonly NewTabLayoutDef[] = [];
  const listeners = new Set<() => void>();

  function change(next: readonly NewTabLayoutDef[]) {
    layouts = next;
    listeners.forEach((listener) => listener());
  }

  function register(def: NewTabLayoutDef) {
    if (layouts.some((l) => l.id === def.id)) throw new Error(`New tab layout already registered: ${def.id}`);
    change([...layouts, def]);
  }

  /** Removes an installed layout; a built-in one stays. */
  function unregister(id: string) {
    if (layouts.some((l) => l.id === id && l.source === "plugin")) change(layouts.filter((l) => l.id !== id));
  }

  function get(id: string | undefined): NewTabLayoutDef | undefined {
    return layouts.find((l) => l.id === id);
  }

  /** The layout with this id, or the default one: the id saved in the
   * settings may belong to a plugin uninstalled since. */
  function resolve(id?: string): NewTabLayoutDef {
    const found = get(id) ?? get(DEFAULT_NEW_TAB_LAYOUT);
    if (!found) throw new Error(`Default new tab layout not registered: ${DEFAULT_NEW_TAB_LAYOUT}`);
    return found;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { register, unregister, list: () => layouts, get, resolve, subscribe };
}

const registry = createLayoutRegistry();

export const registerNewTabLayout = registry.register;
export const unregisterNewTabLayout = registry.unregister;
export const newTabLayouts = registry.list;
export const newTabLayout = registry.get;
export const resolveNewTabLayout = registry.resolve;

/** The registered layouts, kept current as plugin layouts are installed and removed. */
export function useNewTabLayouts(): readonly NewTabLayoutDef[] {
  return useSyncExternalStore(registry.subscribe, registry.list);
}

/** The name a layout goes by in the picker, in the UI language. */
export function layoutLabel(def: NewTabLayoutDef, t: (key: MessageKey) => string, language: string): string {
  return def.labels?.[language] ?? def.label ?? (def.labelKey ? t(def.labelKey) : def.id);
}
