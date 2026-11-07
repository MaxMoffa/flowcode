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
  /** Where the agent runs: a chat tab or a terminal tab. */
  kind: "chat" | "terminal";
  /** The tab it runs in. */
  tabId: string | null;
  /** The tab's working directory ("" when unknown). */
  cwd: string;
  /** Set when the chat is a delegated child: who asked for the task, and where that chat's tab is. */
  delegateOf: DelegateOf | null;
}

interface DelegateOf {
  taskId: string;
  parentTabId: string;
  parentLabel: string;
  parentAgent: string;
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
    a.status === b.status &&
    a.kind === b.kind &&
    a.tabId === b.tabId &&
    a.cwd === b.cwd &&
    a.delegateOf?.taskId === b.delegateOf?.taskId &&
    a.delegateOf?.parentTabId === b.delegateOf?.parentTabId &&
    a.delegateOf?.parentLabel === b.delegateOf?.parentLabel &&
    a.delegateOf?.parentAgent === b.delegateOf?.parentAgent);

// App knows the active tab, the popovers live in portals far from it.
const store = createStore<ActiveAgent | null>(null, same);

export const setActiveAgent = store.set;
export type { ActiveAgent, DelegateOf };
export const useActiveAgent = store.use;
