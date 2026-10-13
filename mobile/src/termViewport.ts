import { useEffect, useState, type RefObject } from "react";

/** The soft keyboard counts as open when the visible height drops this much below its tallest. */
const KEYBOARD_MIN_SHRINK = 100;

/**
 * Keeps the document from scrolling while the terminal page is up. The webview
 * scrolls the page to reveal the focused textarea; the screen is already sized
 * to the visual viewport (`--app-h`), so any scroll is a glitch to undo.
 * Also derives the keyboard state from the viewport (Android Back can hide the
 * IME without a blur) and, with `screenRef`, follows visualViewport.offsetTop.
 */
export function useTerminalViewport(screenRef: RefObject<HTMLElement | null>, onKeyboardHidden: () => void): boolean {
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("term-lock");
    const vv = window.visualViewport;
    let baseline = vv?.height ?? window.innerHeight;
    let open = false;
    const sync = () => {
      window.scrollTo(0, 0);
      root.scrollTop = 0;
      document.body.scrollTop = 0;
      const screen = screenRef.current;
      if (screen) screen.style.transform = vv && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
      const h = vv?.height ?? window.innerHeight;
      baseline = Math.max(baseline, h);
      const next = h < baseline - KEYBOARD_MIN_SHRINK;
      if (next !== open) {
        open = next;
        setKbOpen(next);
        if (!next) onKeyboardHidden();
      }
    };
    // A rotation changes what "full height" means.
    const reset = () => {
      baseline = vv?.height ?? window.innerHeight;
      sync();
    };
    sync();
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    window.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", reset);
    return () => {
      root.classList.remove("term-lock");
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", reset);
      if (screenRef.current) screenRef.current.style.transform = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return kbOpen;
}

/** Exposes the key bar's height as `--keybar-h` (on the screen and on <html>) so toasts can sit above it. */
export function useKeybarHeight(screenRef: RefObject<HTMLElement | null>, barRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const screen = screenRef.current;
    const bar = barRef.current;
    if (!screen || !bar) return;
    const apply = () => {
      const v = `${bar.offsetHeight}px`;
      screen.style.setProperty("--keybar-h", v);
      document.documentElement.style.setProperty("--keybar-h", v);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--keybar-h");
    };
  }, [screenRef, barRef]);
}
