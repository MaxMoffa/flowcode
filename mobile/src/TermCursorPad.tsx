import { useRef } from "react";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import type { Active, NamedKey } from "./termModifiers";

/** Horizontal travel per Left/Right, vertical travel per Up/Down. */
const STEP_X = 14;
const STEP_Y = 24;
/** Haptic ticks are throttled so a fast swipe doesn't buzz continuously. */
const TICK_MS = 45;

/**
 * Thin strip under the key row: drag sideways to move the cursor in the prompt
 * (one arrow per ~14px), up/down to walk history (one per ~24px). Armed
 * modifiers are read once when the drag starts and apply to every step
 * (ctrl+drag = word jumps), then disarm when the finger lifts.
 */
export function TermCursorPad({ peek, onKey, onDone }: { peek: () => Active; onKey: (key: NamedKey, mods: Active) => void; onDone: () => void }) {
  const drag = useRef<{ id: number; x: number; y: number; mods: Active; sent: boolean } | null>(null);
  const lastTick = useRef(0);

  const step = (key: NamedKey, mods: Active) => {
    onKey(key, mods);
    const now = performance.now();
    if (now - lastTick.current >= TICK_MS) {
      lastTick.current = now;
      tapFeedback();
    }
  };

  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.sent) onDone();
  };

  return (
    <div
      className="tm-pad"
      aria-hidden="true"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, mods: peek(), sent: false };
      }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const nx = Math.trunc((e.clientX - d.x) / STEP_X);
        if (nx) {
          for (let i = 0; i < Math.abs(nx); i++) step(nx > 0 ? "right" : "left", d.mods);
          d.x += nx * STEP_X;
          d.sent = true;
        }
        const ny = Math.trunc((e.clientY - d.y) / STEP_Y);
        if (ny) {
          for (let i = 0; i < Math.abs(ny); i++) step(ny > 0 ? "down" : "up", d.mods);
          d.y += ny * STEP_Y;
          d.sent = true;
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span>{t("termCursorHint")}</span>
    </div>
  );
}
