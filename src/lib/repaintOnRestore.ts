import { getCurrentWindow } from "@tauri-apps/api/window";

/** The window is transparent and its panels are `backdrop-filter` glass, and
 * WebView2 sometimes comes back from a minimize showing only the blur - the
 * content isn't recomposited until the window is nudged (moved, resized).
 * Switching the blur off for a frame and back on when the window returns is
 * enough of a nudge. It only runs after the window was really hidden, so a
 * plain alt-tab doesn't flicker. */
export function installRepaintOnRestore(): () => void {
  const appWindow = getCurrentWindow();
  let wasHidden = false;
  let repainting = false;

  const repaint = () => {
    if (!wasHidden || repainting) return;
    wasHidden = false;
    repainting = true;
    const root = document.documentElement;
    root.setAttribute("data-repaint", "");
    const restore = () => {
      root.removeAttribute("data-repaint");
      repainting = false;
    };
    // A hidden webview may not run frames yet: don't get stuck without blur.
    const fallback = window.setTimeout(restore, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        restore();
      }),
    );
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") wasHidden = true;
    else repaint();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const unlisten = Promise.all([
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) repaint();
    }),
    // Not every minimize hides the page: ask the window itself.
    appWindow.onResized(() => {
      void appWindow
        .isMinimized()
        .then((minimized) => {
          if (minimized) wasHidden = true;
          else repaint();
        })
        .catch(() => {});
    }),
  ]);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    void unlisten.then((fns) => fns.forEach((fn) => fn())).catch(() => {});
  };
}
