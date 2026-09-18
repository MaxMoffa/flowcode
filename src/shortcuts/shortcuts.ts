import { invoke } from "@tauri-apps/api/core";

export type ShortcutMap = Record<string, string>;

export const SHORTCUT_ACTIONS = [
  "newTab",
  "closeTab",
  "toggleSidebar",
  "toggleTheme",
  "clearTerminal",
  "copy",
  "paste",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

const FALLBACK_DEFAULTS: ShortcutMap = {
  newTab: "Ctrl+T",
  closeTab: "Ctrl+W",
  toggleSidebar: "Ctrl+B",
  toggleTheme: "Ctrl+Shift+L",
  clearTerminal: "Ctrl+K",
  copy: "Ctrl+Shift+C",
  paste: "Ctrl+Shift+V",
};

export async function loadShortcuts(): Promise<ShortcutMap> {
  let defaults: ShortcutMap = FALLBACK_DEFAULTS;
  let overrides: ShortcutMap = {};

  try {
    defaults = JSON.parse(await invoke<string>("read_shortcuts_defaults"));
  } catch {
    // bundled config/shortcuts.json missing (e.g. plain browser dev) - use fallback
  }

  try {
    overrides = JSON.parse(await invoke<string>("read_shortcuts_overrides"));
  } catch {
    // no user overrides saved yet
  }

  return { ...defaults, ...overrides };
}

export async function saveShortcutOverrides(overrides: ShortcutMap): Promise<void> {
  await invoke("write_shortcuts_overrides", { contents: JSON.stringify(overrides, null, 2) });
}

/** Normalizes a KeyboardEvent into the same "Ctrl+Shift+L" shape used by config JSON. */
export function eventToShortcutString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Cmd");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Control", "Meta", "Alt", "Shift"].includes(e.key)) parts.push(key);
  return parts.join("+");
}
