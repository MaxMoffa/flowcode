import { useCallback } from "react";
import { DUR_OUT, motionMs } from "../lib/motion";

const SLACK_MS = 80;

/**
 * A ref for an overlay (modal, popover, drawer) that its parent unmounts
 * outright: on unmount a still copy is left in its place with `is-leaving`
 * and removed once its exit animation (CSS, on `.is-leaving`) is over. The
 * dozen call sites keep their plain `{open && <Dialog/>}` instead of each
 * holding the dialog mounted through an exit. Fixed/absolute overlays only:
 * an in-flow copy would take room next to the real content.
 */
export function useExitGhost<T extends HTMLElement>(exitMs: number = DUR_OUT[2]): (el: T | null) => void | (() => void) {
  return useCallback(
    (el: T | null) => {
      if (!el) return;
      // React runs this before it takes the element out of the DOM.
      return () => {
        const parent = el.parentNode;
        const ms = motionMs(exitMs);
        if (!parent || ms === 0) return;
        const ghost = el.cloneNode(true) as HTMLElement;
        ghost.classList.add("is-leaving");
        ghost.removeAttribute("id");
        ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        parent.insertBefore(ghost, el.nextSibling);
        const remove = () => ghost.remove();
        // StrictMode's dev double-mount detaches and reattaches the same node: it is still connected then.
        queueMicrotask(() => {
          if (el.isConnected) remove();
        });
        ghost.addEventListener("animationend", (e) => e.target === ghost && remove());
        window.setTimeout(remove, ms + SLACK_MS);
      };
    },
    [exitMs],
  );
}
