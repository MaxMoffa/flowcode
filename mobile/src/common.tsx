import type { Tab } from "./remote";

/** Last two path segments: a full path never fits a phone. */
export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? cwd : `.../${parts.slice(-2).join("/")}`;
}

export function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function contextPercent(tab: Tab): number | null {
  const c = tab.context;
  if (!c || !c.window) return null;
  return Math.min(100, Math.round((c.used / c.window) * 100));
}
