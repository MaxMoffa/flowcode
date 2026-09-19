import type { CSSProperties } from "react";

export const USAGE_POPOVER_WIDTH = 260;
const VIEWPORT_MARGIN = 8;
/** Below this much vertical room, flipping the popover above the trigger
 * (anchored by `bottom`, so it grows upward without needing to know its
 * real height up front) reads better than clamping it short below. */
const MIN_SPACE_BELOW = 160;

/** Keeps a usage popover fully on-screen without ever measuring its actual
 * (content-dependent) height first: below the trigger by default, capped by
 * `maxHeight` + scroll as a backstop; flipped above (grown upward via
 * `bottom`, not `top`) when there isn't enough room below but there is
 * above. Shared by the shortcut-bar button and the plugin menu's rows so
 * both popovers behave identically. */
export function usagePopoverPosition(rect: DOMRect): CSSProperties {
  const spaceBelow = window.innerHeight - rect.bottom - 6;
  const spaceAbove = rect.top - 6;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, window.innerWidth - USAGE_POPOVER_WIDTH - VIEWPORT_MARGIN),
  );
  if (spaceBelow < MIN_SPACE_BELOW && spaceAbove > spaceBelow) {
    return { bottom: window.innerHeight - rect.top + 6, left, maxHeight: spaceAbove - VIEWPORT_MARGIN };
  }
  return { top: rect.bottom + 6, left, maxHeight: spaceBelow - VIEWPORT_MARGIN };
}
