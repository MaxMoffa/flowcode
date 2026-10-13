import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/** With several windows open, only one publishes usage / actions / settings to
 * the phone and keeps usage fetched for it - otherwise they overwrite each
 * other and every window runs the same probes. The rule mirrors
 * `default_window()` in src-tauri/src/remote.rs: "main" while it exists, else
 * the lowest label, so the leader is also the window the backend sends its
 * requests to. */
const RECHECK_MS = 5000;

const ownLabel = getCurrentWindow().label;
// Until the first check, only the main window assumes the role.
let leader = ownLabel === "main";
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function recheck() {
  let next = true;
  try {
    const labels = (await getAllWebviewWindows()).map((w) => w.label);
    const lead = labels.includes("main") ? "main" : [...labels].sort()[0];
    next = lead === undefined || lead === ownLabel;
  } catch {
    // Can't tell: stay as we are rather than flap.
    return;
  }
  if (next !== leader) {
    leader = next;
    listeners.forEach((l) => l());
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void recheck();
    timer = setInterval(() => void recheck(), RECHECK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function isRemoteLeader(): boolean {
  return leader;
}

/** Calls `onChange` whenever this window gains or loses the role. */
export function watchRemoteLeader(onChange: (leader: boolean) => void): () => void {
  return subscribe(() => onChange(leader));
}

export function useRemoteLeader(): boolean {
  return useSyncExternalStore(subscribe, isRemoteLeader);
}
