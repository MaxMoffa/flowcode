import { useSyncExternalStore } from "react";

/** The agent session running in the active terminal tab - what the usage
 * popover's context section reads. */
export interface ActiveAgent {
  cli: string;
  sessionId: string | null;
  profile: string | null;
  /** Set for an agent inside WSL, whose transcripts this reader can't reach. */
  wsl: boolean;
  tabLabel: string;
}

// A tiny external store rather than a context: App knows the active tab, the
// popovers live in portals far from it.
let current: ActiveAgent | null = null;
const listeners = new Set<() => void>();

const same = (a: ActiveAgent | null, b: ActiveAgent | null) =>
  a === b ||
  (!!a && !!b && a.cli === b.cli && a.sessionId === b.sessionId && a.profile === b.profile && a.wsl === b.wsl && a.tabLabel === b.tabLabel);

export function setActiveAgent(next: ActiveAgent | null) {
  if (same(current, next)) return;
  current = next;
  listeners.forEach((l) => l());
}

export function useActiveAgent(): ActiveAgent | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
