import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

// navigator.onLine can be true on Wi-Fi without internet, hence the Rust probe.
let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
let inflight: Promise<boolean> | null = null;
let poll: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const changeListeners = new Set<(online: boolean) => void>();

export function isOnline(): boolean {
  return online;
}

function setOnline(next: boolean) {
  if (next === online) return;
  online = next;
  if (next) {
    if (poll) clearInterval(poll);
    poll = undefined;
  } else if (!poll) {
    poll = setInterval(() => void checkOnline(), 10_000);
  }
  listeners.forEach((l) => l());
  changeListeners.forEach((l) => l(next));
}

export function checkOnline(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setOnline(false);
    return Promise.resolve(false);
  }
  if (inflight) return inflight;
  inflight = invoke<boolean>("network_online")
    .then((ok) => {
      setOnline(ok);
      return ok;
    })
    // Probe failure says nothing about the network: keep the current value.
    .catch(() => online)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function noteNetworkTrouble(): void {
  if (online) void checkOnline();
}

/** Evidence the network works (an agent streamed a reply). */
export function noteNetworkOk(): void {
  if (!online) setOnline(true);
}

export function onOnlineChange(fn: (online: boolean) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline);
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("online", () => void checkOnline());
  void checkOnline();
}
