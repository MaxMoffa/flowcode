// Android Back button for in-app layers (terminal, drawers, sheets).
// Each active layer owns one history entry; Back pops it and closes the
// topmost layer. Tauri's `onBackButtonPress` is not used: registering it
// disables the platform's default exit, which the root screen wants to keep,
// while WebView already turns Back into history navigation.
import { useEffect, useRef } from "react";

interface Entry {
  call: () => void;
  pushed: boolean;
}

const stack: Entry[] = [];
let popping = false;
let pendingPops = 0;

/** A closing menu must finish its Back before a newly opened Browser pushes its entry. */
function flushHistory() {
  if (popping) return;
  if (pendingPops > 0) {
    pendingPops--;
    popping = true;
    history.back();
    return;
  }
  for (const entry of stack) {
    if (entry.pushed) continue;
    history.pushState({ flowcodeBack: true }, "");
    entry.pushed = true;
  }
}

window.addEventListener("popstate", () => {
  if (popping) {
    popping = false;
    flushHistory();
    return;
  }
  stack.pop()?.call();
});

/** While `active`, the Back button calls `onBack` (the last registered active handler wins). */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { call: () => cb.current(), pushed: false };
    stack.push(entry);
    flushHistory();
    return () => {
      // Closed by something other than Back: drop the entry we pushed.
      const i = stack.indexOf(entry);
      if (i === -1) return;
      stack.splice(i, 1);
      if (entry.pushed) pendingPops++;
      flushHistory();
    };
  }, [active]);
}

/** Closes an open sheet or menu on Escape (hardware keyboards); `onClose` may change every render. */
export function useEscape(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
