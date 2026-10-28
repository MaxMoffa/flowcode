import { labelForCwd } from "../terminal/tabTitle";
import type { AppTab, TermTab } from "./types";

/** A terminal tab starting in `cwd`, with the folder also shown in the
 * explorer and its path as the label. `extra` overrides any of that. */
export function makeTermTab(id: string, cwd: string, extra?: Partial<TermTab>): TermTab {
  return { kind: "terminal", id, cwd, explorerPath: cwd, label: labelForCwd(cwd), ...extra };
}

/** A new tab page shown as a dialog (see `TermTab.dialog`), not as a tab. */
export function isDialogTab(tab: AppTab): boolean {
  return tab.kind === "terminal" && !!tab.dialog;
}

/** The tabs the strip, the shortcuts and the phone know about: all but the dialog. */
export function listedTabs<T extends AppTab>(tabs: T[]): T[] {
  return tabs.some(isDialogTab) ? tabs.filter((t) => !isDialogTab(t)) : tabs;
}

/** `tabs` with terminal `id` patched - and the very same array back when
 * nothing actually changed. Title events arrive on every prompt, mostly
 * repeating what the tab already says; handing React a new array (or tab
 * object) for each would re-render the whole shell for nothing.
 *
 * `patch` may be a function of the current tab, returning `null` to leave it
 * alone (a guard that has to look at the tab's present state). */
export function patchTermTab(
  tabs: AppTab[],
  id: string,
  patch: Partial<TermTab> | ((tab: TermTab) => Partial<TermTab> | null),
): AppTab[] {
  const index = tabs.findIndex((t) => t.id === id);
  const tab = tabs[index];
  if (!tab || tab.kind !== "terminal") return tabs;
  const changes = typeof patch === "function" ? patch(tab) : patch;
  if (!changes) return tabs;
  const keys = Object.keys(changes) as (keyof TermTab)[];
  if (keys.every((key) => tab[key] === changes[key])) return tabs;
  const next = tabs.slice();
  next[index] = { ...tab, ...changes };
  return next;
}
