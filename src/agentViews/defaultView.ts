import { useSyncExternalStore } from "react";
import { readString, writeString } from "../lib/storage";
import { DEFAULT_ACP_VIEW } from "./registry";

const STORAGE_KEY = "flowcode.defaultAgentView";

/** The view new chat tabs open with on this computer (phones and tablets keep their own). */
let current = readString(STORAGE_KEY) || DEFAULT_ACP_VIEW;
const listeners = new Set<() => void>();

export const defaultAgentView = (): string => current;

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
