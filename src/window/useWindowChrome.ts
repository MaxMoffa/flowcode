import { useEffect, useState } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const appWindow = getCurrentWindow();

/** The window's maximized / snapped-flush / fullscreen state, kept in step
 * with the OS, and the corner squaring that follows from it. */
export function useWindowChrome() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isEdgeFlush, setIsEdgeFlush] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let recheckTimer: ReturnType<typeof setTimeout> | null = null;
    // Windows Snap (tiling two windows side by side) is not "maximized" as
    // far as `isMaximized()` (win32 `IsZoomed`) is concerned - the window is
    // just resized to half the work area. But a snapped window always spans
    // the full work-area height, so it's flush against the top and bottom
    // screen edges the same way a real maximized window is; without this,
    // the floating window's 1px border (and DWM's own rounded corners, see
    // the effect below) stay on and read as a stray outline/notch against
    // the screen edge and the neighboring window.
    const updateMaximizedState = async () => {
      const maximized = await appWindow.isMaximized();
      if (cancelled) return;
      setIsMaximized(maximized);
      appWindow
        .isFullscreen()
        .then((full) => !cancelled && setIsFullscreen(full))
        .catch(() => {});
      if (maximized) {
        setIsEdgeFlush(false);
        return;
      }
      try {
        const monitor = await currentMonitor();
        if (cancelled) return;
        if (!monitor) {
          setIsEdgeFlush(false);
          return;
        }
        const [pos, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        if (cancelled) return;
        // All four values are physical pixels: `outerPosition`/`outerSize` come
        // from win32 `GetWindowRect` and `workArea` from `GetMonitorInfoW`'s
        // `rcWork`, both unscaled. Don't mix in `scaleFactor` here.
        const { position: workPos, size: workSize } = monitor.workArea;
        // Generous tolerance: Windows 11's "show a small gap between snapped
        // windows" setting insets a snapped window a few px from the work
        // area on top of normal DPI-scaling rounding, so an exact (or
        // near-exact) match is too strict to ever fire. (Measured on a real
        // Snap here the match is in fact exact, but leave room for the gap
        // setting and for other DPI configurations.)
        const EDGE_TOLERANCE = 24;
        const flushTop = Math.abs(pos.y - workPos.y) <= EDGE_TOLERANCE;
        const flushBottom = Math.abs(pos.y + size.height - (workPos.y + workSize.height)) <= EDGE_TOLERANCE;
        setIsEdgeFlush(flushTop && flushBottom);
      } catch (err) {
        // Don't swallow silently: a bad API call here looks exactly like "the
        // window simply isn't snapped", which hid an `appWindow.currentMonitor`
        // TypeError for a long time.
        console.error("[snap-detect] failed to read window/monitor geometry", err);
        if (!cancelled) setIsEdgeFlush(false);
      }
    };
    updateMaximizedState();
    // onMoved/onResized fire every frame while dragging, and each read is
    // several IPC calls: read once things settle (which also covers Windows
    // Snap's animation into place).
    const recheck = () => {
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = setTimeout(updateMaximizedState, 150);
    };
    // `onMoved` as well as `onResized`: snapping from one half to the other
    // (or dragging a full-height window onto another monitor) changes the
    // position without changing the size, so WM_SIZE - and therefore
    // `onResized` - never fires.
    const unlisten = Promise.all([appWindow.onResized(recheck), appWindow.onMoved(recheck)]);
    return () => {
      cancelled = true;
      if (recheckTimer) clearTimeout(recheckTimer);
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    // DWM rounds this window's corners unconditionally (see
    // apply_window_chrome/set_window_corner_rounding in shared/src/lib.rs);
    // that only goes unnoticed on a floating window. Flush against the
    // screen edge or a neighboring Snapped window, the rounded clip nicks a
    // visible notch out of the corner, so square it off there instead.
    invoke("set_window_square_corners", { square: isMaximized || isEdgeFlush || isFullscreen }).catch(() => {});
  }, [isMaximized, isEdgeFlush, isFullscreen]);

  function toggleFullscreen() {
    appWindow
      .setFullscreen(!isFullscreen)
      // Ask the window rather than flipping the flag: the OS may refuse.
      .then(() => appWindow.isFullscreen())
      .then(setIsFullscreen)
      .catch(() => {});
  }

  return { isMaximized, isEdgeFlush, isFullscreen, toggleFullscreen };
}
