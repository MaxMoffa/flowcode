import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { send } from "./remote";
import { tapFeedback } from "./haptics";

const SLOP = 8; // px of travel before a touch stops being a tap
const MAX_LINES_PER_STEP = 12;
const FRICTION = 0.94; // per 16 ms frame
const MIN_SPEED = 0.03; // px/ms
const LONG_PRESS_MS = 450;

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
 * handler, which focuses the terminal. A long press selects the word under the
 * finger, and dragging then extends the selection.
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
    let pressTimer = 0;
    let selecting = false;
    let anchorStart = 0; // linear cell index (row * cols + col) of the pressed word's start
    let anchorEnd = 0;
    let suppressClick = false;

    const cellAt = (x: number, y: number) => {
      const term = termRef.current;
      const screen = area.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) return null;
      const r = screen.getBoundingClientRect();
      const col = Math.min(term.cols - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * term.cols)));
      const row = Math.min(term.rows - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * term.rows)));
      return { col, row: row + term.buffer.active.viewportY };
    };
    const selectRange = (s: number, e: number) => {
      const term = termRef.current;
      if (!term) return;
      term.select(s % term.cols, Math.floor(s / term.cols), e - s + 1);
    };

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
      suppressClick = false;
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        const term = termRef.current;
        if (!term || !touching || axis) return;
        const c = cellAt(x0, y0);
        if (!c) return;
        const text = term.buffer.active.getLine(c.row)?.translateToString(false) ?? "";
        const blank = (i: number) => !text[i] || /\s/.test(text[i]);
        let ws = c.col;
        let we = c.col;
        if (!blank(c.col)) {
          while (ws > 0 && !blank(ws - 1)) ws--;
          while (we < term.cols - 1 && !blank(we + 1)) we++;
        }
        anchorStart = c.row * term.cols + ws;
        anchorEnd = c.row * term.cols + we;
        selectRange(anchorStart, anchorEnd);
        selecting = true;
        suppressClick = true;
        cancelAnimationFrame(id);
        tapFeedback();
      }, LONG_PRESS_MS);
    };
    const move = (e: TouchEvent) => {
      if (!touching || e.touches.length !== 1) return;
      const p = e.touches[0];
      if (selecting) {
        e.preventDefault();
        const c = cellAt(p.clientX, p.clientY);
        const term = termRef.current;
        if (!c || !term) return;
        const cur = c.row * term.cols + c.col;
        selectRange(Math.min(anchorStart, cur), Math.max(anchorEnd, cur));
        return;
      }
      if (!axis) {
        const ax = Math.abs(p.clientX - x0);
        const ay = Math.abs(p.clientY - y0);
        if (Math.max(ax, ay) < SLOP) return;
        axis = ax > ay ? "x" : "y";
        window.clearTimeout(pressTimer);
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
      window.clearTimeout(pressTimer);
      if (selecting) {
        selecting = false;
        touching = false;
        return;
      }
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
    const onClick = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    const onContextMenu = (e: Event) => e.preventDefault(); // the WebView's own long-press menu
    area.addEventListener("click", onClick, true);
    area.addEventListener("contextmenu", onContextMenu);
    return () => {
      cancelAnimationFrame(id);
      window.clearTimeout(pressTimer);
      area.removeEventListener("click", onClick, true);
      area.removeEventListener("contextmenu", onContextMenu);
      area.removeEventListener("touchstart", start);
      area.removeEventListener("touchmove", move);
      area.removeEventListener("touchend", end);
      area.removeEventListener("touchcancel", end);
    };
  }, [areaRef, termRef, ptyId]);
}
