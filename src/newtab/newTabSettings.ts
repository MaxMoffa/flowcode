import { useCallback, useSyncExternalStore } from "react";
import { readString, writeString } from "../lib/storage";
import { DEFAULT_NEW_TAB_LAYOUT } from "./layouts";

const STORAGE_KEY = "flowcode.newTabLayout";

export type NewTabBackground = "theme" | "solid" | "image";
const BACKGROUNDS: readonly NewTabBackground[] = ["theme", "solid", "image"];

/** The parts of a layout the user can hide. */
export interface NewTabSections {
  recents: boolean;
  favorites: boolean;
  /** The "Vetro" layout's agent chips. */
  agents: boolean;
}

/** How the new tab page looks, set from its "Personalizza" panel. */
export interface NewTabSettings {
  /** Id of the layout in the registry (see layouts.ts). */
  layout: string;
  sections: NewTabSections;
  /** The "Vetro" layout's backdrop. */
  background: NewTabBackground;
  /** Strength of its grain texture, 0-1. */
  grain: number;
  /** Blur behind its cards, in px. */
  blur: number;
}

export const GRAIN_RANGE = { min: 0, max: 1, step: 0.05 } as const;
export const BLUR_RANGE = { min: 0, max: 40, step: 1 } as const;

const DEFAULTS: NewTabSettings = {
  layout: DEFAULT_NEW_TAB_LAYOUT,
  sections: { recents: true, favorites: true, agents: true },
  background: "theme",
  grain: 0.5,
  blur: 16,
};

function numberIn(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Whatever was stored, with every field that is missing or off turned back to its default. */
function parseNewTabSettings(raw: string | null): NewTabSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    /* unreadable: the defaults */
  }
  const sections = (stored.sections && typeof stored.sections === "object" ? stored.sections : {}) as Record<string, unknown>;
  const flag = (name: keyof NewTabSections) => (typeof sections[name] === "boolean" ? sections[name] : DEFAULTS.sections[name]);
  return {
    layout: typeof stored.layout === "string" && stored.layout !== "" ? stored.layout : DEFAULTS.layout,
    sections: { recents: flag("recents") as boolean, favorites: flag("favorites") as boolean, agents: flag("agents") as boolean },
    background: BACKGROUNDS.includes(stored.background as NewTabBackground) ? (stored.background as NewTabBackground) : DEFAULTS.background,
    grain: numberIn(stored.grain, DEFAULTS.grain, GRAIN_RANGE),
    blur: numberIn(stored.blur, DEFAULTS.blur, BLUR_RANGE),
  };
}

const listeners = new Set<() => void>();
// The same reference until something changes, as `useSyncExternalStore` requires.
let cache = parseNewTabSettings(readString(STORAGE_KEY));

function change(next: NewTabSettings) {
  cache = next;
  writeString(STORAGE_KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

// A write from another window refreshes this one's cache too; `key === null`
// is localStorage.clear().
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  cache = parseNewTabSettings(readString(STORAGE_KEY));
  listeners.forEach((listener) => listener());
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getNewTabSettings = () => cache;

export function setNewTabSettings(patch: Partial<Omit<NewTabSettings, "sections">> & { sections?: Partial<NewTabSections> }) {
  change({ ...cache, ...patch, sections: { ...cache.sections, ...patch.sections } });
}

export function useNewTabSettings(): [NewTabSettings, typeof setNewTabSettings] {
  const settings = useSyncExternalStore(subscribe, getNewTabSettings);
  return [settings, useCallback(setNewTabSettings, [])];
}
