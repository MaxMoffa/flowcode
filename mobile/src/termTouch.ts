import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { send } from "./remote";

const SLOP = 8; // px of travel before a touch stops being a tap
const MAX_LINES_PER_STEP = 12;
const FRICTION = 0.94; // per 16 ms frame
const MIN_SPEED = 0.03; // px/ms

/**
 * Scrolls `lines` (positive = towards newer output / down) in whatever the
 * terminal shows: the scrollback of the normal buffer, or, on the alternate
 * screen (full-screen TUIs), wheel events when the app tracks the mouse and
 * arrow keys otherwise.
 */
function scrollTerminal(term: Terminal, ptyId: string, lines: number) {
  if (!lines) return;
  const n = Math.min(Math.abs(lines), MAX_LINES_PER_STEP);
  if (term.buffer.active.type !== "alternate") {
    term.scrollLines(lines);
    return;
  }
  let data: string;
  if (term.modes.mouseTrackingMode !== "none") {
    // SGR wheel report at the screen's middle; 64 = wheel up (older), 65 = down.
    // (xterm does not expose whether the app asked for SGR; nearly all do.)
    const col = Math.max(1, Math.floor(term.cols / 2));
    const row = Math.max(1, Math.floor(term.rows / 2));
    data = `\x1b[<${lines < 0 ? 64 : 65};${col};${row}M`.repeat(n);
  } else {
    const o = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
    data = (o + (lines < 0 ? "A" : "B")).repeat(n);
  }
  send({ t: "input", ptyId, data });
}

/**
 * One-finger drag on the terminal area: vertical scrolls lines with inertia,
 * horizontal pans an over-wide pty. A tap (no travel) is left to the click
 * handler, which focuses the terminal.
 */
export function useTouchScroll(areaRef: RefObject<HTMLElement | null>, termRef: RefObject<Terminal | null>, ptyId: string) {
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let id = 0; // inertia animation frame
    let touching = false;
    let axis: "x" | "y" | null = null;
    let x0 = 0;
    let y0 = 0;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let speed = 0; // px/ms along y, smoothed
    let rest = 0; // sub-line remainder in px

    const cellH = () => {
      const term = termRef.current;
      const screen = area.querySelector<HTMLElement>(".xterm-screen");
      return term && screen && term.rows > 0 && screen.offsetHeight > 0 ? screen.offsetHeight / term.rows : 18;
    };
    const dragBy = (dy: number) => {
      const term = termRef.current;
      if (!term) return;
      rest += dy;
      const h = cellH();
      const whole = Math.trunc(rest / h);
      if (whole) {
        rest -= whole * h;
        scrollTerminal(term, ptyId, -whole); // finger down = older output
      }
    };

    const start = (e: TouchEvent) => {
      cancelAnimationFrame(id);
      if (e.touches.length !== 1) return;
      const p = e.touches[0];
      touching = true;
      axis = null;
      x0 = lastX = p.clientX;
      y0 = lastY = p.clientY;
      lastT = e.timeStamp;
      speed = 0;
      rest = 0;
    };
    const move = (e: TouchEvent) => {
      if (!touching || e.touches.length !== 1) return;
      const p = e.touches[0];
      if (!axis) {
        const ax = Math.abs(p.clientX - x0);
        const ay = Math.abs(p.clientY - y0);
        if (Math.max(ax, ay) < SLOP) return;
        axis = ax > ay ? "x" : "y";
      }
      e.preventDefault(); // no page scroll, no click after a drag
      const dx = p.clientX - lastX;
      const dy = p.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastT);
      lastX = p.clientX;
      lastY = p.clientY;
      lastT = e.timeStamp;
      if (axis === "x") {
        area.scrollLeft -= dx;
      } else {
        speed = 0.8 * (dy / dt) + 0.2 * speed;
        dragBy(dy);
      }
    };
    const end = (e: TouchEvent) => {
      if (!touching) return;
      touching = false;
      if (axis !== "y" || e.timeStamp - lastT > 80) return; // finger rested before lifting: no fling
      let prev = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - prev);
        prev = now;
        dragBy(speed * dt);
        speed *= Math.pow(FRICTION, dt / 16);
        if (Math.abs(speed) > MIN_SPEED) id = requestAnimationFrame(step);
      };
      id = requestAnimationFrame(step);
    };

    area.addEventListener("touchstart", start, { passive: true });
    area.addEventListener("touchmove", move, { passive: false });
    area.addEventListener("touchend", end, { passive: true });
    area.addEventListener("touchcancel", end, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      area.removeEventListener("touchstart", start);
      area.removeEventListener("touchmove", move);
      area.removeEventListener("touchend", end);
      area.removeEventListener("touchcancel", end);
    };
  }, [areaRef, termRef, ptyId]);
}
