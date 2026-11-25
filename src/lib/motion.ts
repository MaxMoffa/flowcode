// JS side of the motion tokens in themes.css (--dur-*): fallback timers must
// match the CSS durations, and drop to 0 when the user asked for less motion.

export const DUR = { 1: 120, 2: 180, 3: 240 } as const;
export const DUR_OUT = { 1: 90, 2: 135, 3: 180 } as const;

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** `ms`, or 0 with reduced motion. */
export function motionMs(ms: number): number {
  return reducedMotion() ? 0 : ms;
}
