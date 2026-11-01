import { useEffect, useRef, type RefObject } from "react";
import type { Window } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { saveWindowSession, type SavedWindow } from "./session";
import { windowSnapshot, type WindowSnapshotState } from "./windowSnapshot";

interface Options {
  ready: boolean;
  window: Window;
  main: boolean;
  dirty: RefObject<boolean>;
  restore: () => boolean;
  state: () => WindowSnapshotState;
  prepareClose: () => Promise<(() => boolean) | null>;
  onError?: (error: unknown) => void;
}

/** Owns persistence ordering, periodic snapshots and the window's close transaction. */
export function useWindowSession(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  // StrictMode can clean up and restart the effect while a write is already
  // in flight. Keep the ordering across those effect generations as well.
  const serial = useRef(Promise.resolve());
  const { ready, window: appWindow } = options;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let closing = false;
    let reportedError: string | null = null;
    let lastSaved: string | null = null;
    const report = (error: unknown, force = false) => {
      const message = String(error);
      if (!cancelled && (force || message !== reportedError)) {
        reportedError = message;
        latest.current.onError?.(error);
      }
    };
    const persist = (flushGen?: number, periodic = false): Promise<void> => {
      const run = async () => {
        if (cancelled) return;
        const opts = latest.current;
        try {
          if (periodic && document.hidden && !opts.dirty.current && !opts.state().tabs.some((t) => t.kind === "terminal" && t.busy)) return;
          opts.dirty.current = false;
          let bounds: SavedWindow["bounds"];
          if (opts.restore() && !opts.main) {
            const minimized = await appWindow.isMinimized().catch(() => false);
            if (cancelled) { opts.dirty.current = true; return; }
            if (!minimized) {
              const geometry = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]).catch(() => null);
              if (cancelled) { opts.dirty.current = true; return; }
              if (geometry) bounds = { x: geometry[0].x, y: geometry[0].y, width: geometry[1].width, height: geometry[1].height };
            }
          }
          if (cancelled) { opts.dirty.current = true; return; }
          const state = opts.state();
          const dirtyEditors = state.dirtyEditors === true;
          const snapshot = opts.restore() ? windowSnapshot(state, bounds) : null;
          const json = JSON.stringify({ snapshot, dirtyEditors });
          if (periodic && json === lastSaved) return;
          await saveWindowSession(snapshot, flushGen, dirtyEditors);
          if (cancelled) { opts.dirty.current = true; return; }
          lastSaved = json;
          reportedError = null;
        } catch (error) {
          // A failed initial save must still be retried while the window is
          // hidden. Preserve any dirty signal raised during a successful save.
          opts.dirty.current = true;
          throw error;
        }
      };
      const pending = serial.current.then(run);
      serial.current = pending.catch(() => {});
      return pending;
    };
    const unsubscribers: (() => void)[] = [];
    const register = (start: () => Promise<() => void>) => {
      try {
        void start().then((off) => {
          if (cancelled) off();
          else unsubscribers.push(off);
        }).catch(report);
      } catch (error) {
        report(error);
      }
    };
    void persist().catch(report);
    const timer = setInterval(() => void persist(undefined, true).catch(report), 15000);
    register(() => appWindow.onCloseRequested(async (event) => {
      if (cancelled) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        const validate = await latest.current.prepareClose();
        if (cancelled || !validate || !validate()) return;
        await persist();
        if (!cancelled && validate()) await appWindow.destroy();
      } catch (error) {
        report(error, true);
      } finally {
        closing = false;
      }
    }));
    register(() => listen<number>("session:flush", (event) => void persist(event.payload).catch(report)));
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const off of unsubscribers) {
        try { off(); } catch { /* cleanup must release the remaining listeners */ }
      }
    };
  }, [ready, appWindow]);
}
