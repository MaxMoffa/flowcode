import { createStore } from "../lib/externalStore";

/** The agent session running in the active terminal tab - what the usage
 * popover's context section reads. */
interface ActiveAgent {
  cli: string;
  sessionId: string | null;
  profile: string | null;
  /** Set for an agent inside WSL, whose transcripts this reader can't reach. */
  wsl: boolean;
  tabLabel: string;
  /** The tab's pty, for typing into the agent (the context section's "compact"). */
  ptyId: string;
  /** "busy" / "waiting" / "idle", when the CLI reports it. */
  status: string | null;
}

const same = (a: ActiveAgent | null, b: ActiveAgent | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.cli === b.cli &&
    a.sessionId === b.sessionId &&
    a.profile === b.profile &&
    a.wsl === b.wsl &&
    a.tabLabel === b.tabLabel &&
    a.ptyId === b.ptyId &&
    a.status === b.status);

// App knows the active tab, the popovers live in portals far from it.
const store = createStore<ActiveAgent | null>(null, same);

export const setActiveAgent = store.set;
export const useActiveAgent = store.use;
