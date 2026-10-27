import { useSyncExternalStore } from "react";
import { readBool, readString, writeString } from "../lib/storage";
import { DEFAULT_ACP_VIEW, TERMINAL_VIEW, agentView } from "./registry";

const STORAGE_KEY = "flowcode.defaultAgentView";
/** The Agents "+" menu's old "As chat" checkbox: seeds the choice for whoever had it on. */
const LEGACY_AS_CHAT_KEY = "flowcode.agentsNewAsChat";

/** The view new agents open with on this computer (phones and tablets keep their own). */
let current = readString(STORAGE_KEY) || (readBool(LEGACY_AS_CHAT_KEY, false) ? DEFAULT_ACP_VIEW : TERMINAL_VIEW);
const listeners = new Set<() => void>();

export const defaultAgentView = (): string => current;

/** Whether new agents open as a chat tab rather than in a terminal. A plugin
 * view not registered yet (they load after startup) still counts as a chat. */
export function defaultOpensChat(): boolean {
  const view = agentView(current);
  return view ? view.transport === "acp" : current !== TERMINAL_VIEW;
}

export function setDefaultAgentView(id: string) {
  current = id;
  writeString(STORAGE_KEY, id);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useDefaultAgentView = (): string => useSyncExternalStore(subscribe, defaultAgentView);
