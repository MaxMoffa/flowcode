/** Whether a limit resetting at `at` may arm a tab. A reset already woken for
 * or cancelled by the user stays on screen and must not arm again; only a
 * strictly later reset does. */
export function shouldArmReset(at: number, woken: number | undefined, cancelled: number | undefined): boolean {
  if (woken !== undefined && at <= woken) return false;
  if (cancelled !== undefined && at <= cancelled) return false;
  return true;
}
