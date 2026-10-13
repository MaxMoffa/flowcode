// Android Back button for in-app layers (terminal, drawers, sheets).
// Each active layer owns one history entry; Back pops it and closes the
// topmost layer. Tauri's `onBackButtonPress` is not used: registering it
// disables the platform's default exit, which the root screen wants to keep,
// while WebView already turns Back into history navigation.
import { useEffect, useRef } from "react";

interface Entry {
  call: () => void;
}

const stack: Entry[] = [];
/** popstate events caused by our own `history.back()` clean-ups. */
let ignore = 0;

window.addEventListener("popstate", () => {
  if (ignore > 0) {
    ignore--;
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
    const entry: Entry = { call: () => cb.current() };
    stack.push(entry);
    history.pushState({ flowcodeBack: true }, "");
    return () => {
      // Closed by something other than Back: drop the entry we pushed.
      const i = stack.indexOf(entry);
      if (i === -1) return;
      stack.splice(i, 1);
      ignore++;
      history.back();
    };
  }, [active]);
}
