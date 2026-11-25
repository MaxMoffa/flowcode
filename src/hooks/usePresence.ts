import { useCallback, useEffect, useState, type AnimationEvent } from "react";
import { DUR, DUR_OUT, motionMs } from "../lib/motion";

export type PresenceState = "entering" | "open" | "closing";

interface Options {
  /** Entrance length (the CSS animation's), for the fallback timer. */
  enterMs?: number;
  /** Exit length, for the fallback timer. */
  exitMs?: number;
  /** Animate in when already open on mount. Off by default: a card or panel present at launch just is there. */
  appear?: boolean;
}

/** Past the CSS duration before the fallback timer settles the state (animationend lost, element hidden...). */
const SLACK_MS = 80;

/**
 * Keeps something mounted while it animates out. Render while `mounted`, put
 * `state` on `data-state` and let CSS run a keyframe animation per state
 * (keyframes, not transitions: they start on the first painted frame, no
 * double-rAF needed). `onAnimationEnd` (on the animated element) settles
 * entering -> open and closing -> unmounted; a timer does it if the event
 * never comes (reduced motion, display:none, a cancelled animation).
 */
export function usePresence(open: boolean, { enterMs = DUR[2], exitMs = DUR_OUT[2], appear = false }: Options = {}) {
  const [s, setS] = useState<{ open: boolean; mounted: boolean; state: PresenceState }>(() => ({
    open,
    mounted: open,
    state: open && appear ? "entering" : "open",
  }));
  // Derived from the prop during render, so the first frame of an opening already carries "entering".
  let cur = s;
  if (s.open !== open) {
    cur = open ? { open, mounted: true, state: "entering" } : { open, mounted: s.mounted, state: s.mounted ? "closing" : "open" };
    setS(cur);
  }

  const done = useCallback(() => {
    setS((p) => (p.state === "entering" ? { ...p, state: "open" } : p.state === "closing" ? { ...p, mounted: false, state: "open" } : p));
  }, []);

  useEffect(() => {
    if (cur.state === "open") return;
    const timer = window.setTimeout(done, motionMs(cur.state === "entering" ? enterMs : exitMs) + SLACK_MS);
    return () => window.clearTimeout(timer);
  }, [cur.state, enterMs, exitMs, done]);

  const onAnimationEnd = useCallback(
    (e: AnimationEvent) => {
      // Children's own animations bubble up here: only the element's own counts.
      if (e.target === e.currentTarget) done();
    },
    [done],
  );

  return { mounted: cur.mounted, state: cur.state, onAnimationEnd, done };
}
