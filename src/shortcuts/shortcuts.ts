import { invoke } from "@tauri-apps/api/core";

export type ShortcutMap = Record<string, string>;

export type ShortcutGroup = "tabs" | "terminal" | "app";

/** Every rebindable action, by the group it's listed under in Settings and
 * in the shortcuts guide. The order here is the display order. */
export const SHORTCUT_GROUPS: Record<ShortcutGroup, readonly string[]> = {
  tabs: [
    "newTab",
    "closeTab",
    "duplicateTab",
    "nextTab",
    "prevTab",
    "moveTabLeft",
    "moveTabRight",
    "selectTab1",
    "selectTab2",
    "selectTab3",
    "selectTab4",
    "selectTab5",
    "selectTab6",
    "selectTab7",
    "selectTab8",
    "lastTab",
  ],
  terminal: ["copy", "paste", "clearTerminal", "zoomIn", "zoomOut", "resetZoom"],
  app: ["toggleSidebar", "toggleAgents", "toggleTheme", "openSettings", "showShortcuts"],
};

export const SHORTCUT_ACTIONS = [
  "newTab",
  "closeTab",
  "duplicateTab",
  "nextTab",
  "prevTab",
  "moveTabLeft",
  "moveTabRight",
  "selectTab1",
  "selectTab2",
  "selectTab3",
  "selectTab4",
  "selectTab5",
  "selectTab6",
  "selectTab7",
  "selectTab8",
  "lastTab",
  "copy",
  "paste",
  "clearTerminal",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "toggleSidebar",
  "toggleAgents",
  "toggleTheme",
  "openSettings",
  "showShortcuts",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = ["tabs", "terminal", "app"];

export function actionsOfGroup(group: ShortcutGroup): ShortcutAction[] {
  return SHORTCUT_GROUPS[group] as ShortcutAction[];
}

/** Mirrors config/shortcuts.json - used when the bundled file can't be read,
 * and to fill in actions an older config doesn't know yet. */
export const FALLBACK_DEFAULTS: Record<ShortcutAction, string> = {
  newTab: "Ctrl+T",
  closeTab: "Ctrl+W",
  duplicateTab: "Ctrl+Shift+D",
  nextTab: "Ctrl+Tab",
  prevTab: "Ctrl+Shift+Tab",
  moveTabLeft: "Ctrl+Shift+PageUp",
  moveTabRight: "Ctrl+Shift+PageDown",
  selectTab1: "Ctrl+1",
  selectTab2: "Ctrl+2",
  selectTab3: "Ctrl+3",
  selectTab4: "Ctrl+4",
  selectTab5: "Ctrl+5",
  selectTab6: "Ctrl+6",
  selectTab7: "Ctrl+7",
  selectTab8: "Ctrl+8",
  lastTab: "Ctrl+9",
  copy: "Ctrl+Shift+C",
  paste: "Ctrl+Shift+V",
  clearTerminal: "Ctrl+K",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  resetZoom: "Ctrl+0",
  toggleSidebar: "Ctrl+B",
  toggleAgents: "Ctrl+Shift+A",
  toggleTheme: "Ctrl+Shift+L",
  openSettings: "Ctrl+,",
  showShortcuts: "F1",
};

/** Combos that must keep reaching the shell: rebinding them would break
 * interrupt / EOF / suspend / paste in every terminal. */
export const RESERVED_COMBOS: readonly string[] = ["Ctrl+C", "Ctrl+D", "Ctrl+Z", "Ctrl+V"];

export async function loadShortcutDefaults(): Promise<ShortcutMap> {
  let bundled: ShortcutMap = {};
  try {
    bundled = JSON.parse(await invoke<string>("read_shortcuts_defaults"));
  } catch {
    // bundled config/shortcuts.json missing (e.g. plain browser dev) - use fallback
  }
  return { ...FALLBACK_DEFAULTS, ...bundled };
}

export async function loadShortcutOverrides(): Promise<ShortcutMap> {
  try {
    return JSON.parse(await invoke<string>("read_shortcuts_overrides"));
  } catch {
    // no user overrides saved yet
    return {};
  }
}

export async function loadShortcuts(): Promise<ShortcutMap> {
  const [defaults, overrides] = await Promise.all([loadShortcutDefaults(), loadShortcutOverrides()]);
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
  if (!["Control", "Meta", "Alt", "Shift"].includes(e.key)) parts.push(keyName(e.key));
  return parts.join("+");
}

/** "+" and " " are named so a combo string can always be split on "+". */
function keyName(key: string): string {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function isModifierOnly(e: KeyboardEvent): boolean {
  return ["Control", "Meta", "Alt", "Shift"].includes(e.key);
}

/** A bound combo has to be something the terminal wouldn't otherwise need
 * for typing: a Ctrl/Alt/Cmd chord, or a function key on its own. */
export function isValidCombo(combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  return parts.some((p) => p === "Ctrl" || p === "Alt" || p === "Cmd");
}

/** The lookup key for a pressed combo. Ctrl+Shift+= produces the key "+"
 * ("Plus") on most layouts while Ctrl+= produces "=" - both mean "plus" to
 * anyone binding zoom in, so they resolve to the same entry. */
export function canonicalCombo(combo: string): string {
  return combo.replace(/\+=$/, "+Plus").replace(/\+Shift\+Plus$/, "+Plus");
}

const KEY_LABELS: Record<string, string> = {
  Plus: "+",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
};

/** A combo as the individual keycaps to draw. Empty when unassigned. */
export function comboKeys(combo: string | undefined): string[] {
  if (!combo) return [];
  return combo.split("+").map((p) => KEY_LABELS[p] ?? p);
}
