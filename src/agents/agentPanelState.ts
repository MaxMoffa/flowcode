import { createContext, type ReactNode } from "react";
import { createStore } from "../lib/externalStore";

const PINNED_KEY = "flowcode.agentPanel.pinned";

const popover = createStore(false);
export const useAgentPopoverOpen = popover.use;
export const setAgentPopoverOpen = (open: boolean) => popover.set(open);
export const toggleAgentPopover = () => popover.update((open) => !open);

function readPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

const pinned = createStore(readPinned());
export const useAgentPanelPinned = pinned.use;
export const getAgentPanelPinned = () => pinned.get();
export function setAgentPanelPinned(value: boolean) {
  try {
    if (value) localStorage.setItem(PINNED_KEY, "1");
    else localStorage.removeItem(PINNED_KEY);
  } catch {
    // Storage unavailable: the choice lasts for the session only.
  }
  pinned.set(value);
}

/** What the header's context pill needs from the app: the panel to show in its
 * popover, and a way to bring up the pinned sidebar copy. */
export interface AgentPanelHost {
  renderPanel: () => ReactNode;
  showPinned: () => void;
}
export const AgentPanelHostContext = createContext<AgentPanelHost | null>(null);
