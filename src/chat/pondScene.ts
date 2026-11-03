// The canvas scenes of the chat's pond footer: the frog sinking into its pond (session ended) or waiting on a lily pad (usage limit).
// Pure DOM/canvas, no Tauri, so the desktop and the phone chat share it.
import { FROG_PIXELS, REST_POSE, frogPalette, frogPixels, type FrogPose } from "../terminal/frogArt";

/** CSS px per frog pixel; everything on the scene is snapped to this grid. */
export const PX = 4;
const COLS = FROG_PIXELS.width;
const ROWS = FROG_PIXELS.height;
const FROG_W = COLS * PX;
const FROG_H = ROWS * PX;
/** The ripples' flattening: the pond is seen from the side. */
const SQUASH = 0.32;
/** The sinking scene stops animating after this long (s), holding its last frame. */
export const SETTLE_S = 12;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The frog with its top left at (left, top), without the rows that fall below `cut` (a y on the canvas). */
export function paintFrog(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, pose: FrogPose, left: number, top: number, cut = Infinity) {
  const pixels = frogPixels(pose, COLS, ROWS, canvas);
  for (let r = 0; r < ROWS; r++) {
    if (top + (r + 1) * PX > cut) break;
    for (let c = 0; c < COLS; c++) {
      const color = pixels[r * COLS + c];
      if (!color) continue;
      ctx.fillStyle = `#${color}`;
      ctx.fillRect(left + c * PX, top + r * PX, PX, PX);
    }
  }
}

/** A ripple as squares of the grid, centered on (cx, cy). */
export function paintRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, alpha: number, color: string) {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const n = Math.max(14, Math.round(r * 1.6));
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const gx = Math.round((cx + Math.cos(a) * r) / PX);
    const gy = Math.round((cy + Math.sin(a) * r * SQUASH) / PX);
    const key = `${gx},${gy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.fillRect(gx * PX, gy * PX, PX, PX);
  }
  ctx.globalAlpha = 1;
}

/** One frame of the scene `kind` at `t` seconds on a `w` x `h` canvas. `still`: the final frame of the reduced-motion version. */
export function paintScene(canvas: HTMLCanvasElement, kind: PondKind, t: number, w: number, h: number, still: boolean, fly: string) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const water = Math.round((h * 0.64) / PX) * PX;
  const left = Math.round((w - FROG_W) / 2 / PX) * PX;
  const mid = left + FROG_W / 2;
  const green = `#${frogPalette(0, canvas).green}`;

  if (kind === "limit") {
    // A lily pad with a notch, the frog on it, a fly it never catches.
    ctx.fillStyle = green;
    ctx.globalAlpha = 0.28;
    for (let gx = -16; gx <= 16; gx++) {
      for (let gy = -3; gy <= 3; gy++) {
        if ((gx / 16) ** 2 + (gy / 3.2) ** 2 > 1 || (gx > 2 && gx < 7 && gy < 0)) continue;
        ctx.fillRect(mid + gx * PX, water + gy * PX, PX, PX);
      }
    }
    ctx.globalAlpha = 1;
    const bob = still ? 0 : Math.round(Math.sin(t * 1.4) * 1.2) * PX;
    const flyX = w / 2 + Math.cos(t * 0.7) * (w * 0.36);
    const flyY = h * 0.3 + Math.sin(t * 2.1) * 14;
    const pose: FrogPose = still
      ? { ...REST_POSE, lid: 0.25, cursor: true }
      : { ...REST_POSE, lookX: Math.max(-28, Math.min(28, (flyX - w / 2) / 6)), lookY: (flyY - water) / 8, lid: 0.25, cursor: Math.floor(t * 2) % 2 === 0 };
    paintFrog(ctx, canvas, pose, left, water - FROG_H + PX * 2 + bob);
    if (still) return;
    const p = (t * 40) % 160;
    paintRing(ctx, mid, water + PX, p + 40, Math.max(0, 0.35 - p / 460), green);
    const fx = Math.round(flyX / PX) * PX;
    const fy = Math.round(flyY / PX) * PX;
    ctx.fillStyle = fly;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(fx, fy, 3, 3);
    ctx.globalAlpha = Math.sin(t * 30) > 0 ? 0.5 : 0.2;
    ctx.fillRect(fx - 2, fy - 2, 2, 2);
    ctx.fillRect(fx + 3, fy - 2, 2, 2);
    ctx.globalAlpha = 1;
    return;
  }

  // The frog sinks: down to its eyes, a last blink, then under; ripples keep going.
  const settled = still || t >= SETTLE_S;
  const sink = still ? 1 : Math.min(1, Math.max(0, (t - 0.6) / 2.4));
  const ease = sink * sink * (3 - 2 * sink);
  const top = water - FROG_H + PX * 2 + Math.round((ease * (FROG_H + PX * 2)) / PX) * PX;
  if (top < water) paintFrog(ctx, canvas, { ...REST_POSE, lid: Math.min(1, t / 2.2), lookY: 14, cursor: false }, left, top, water);
  if (settled) return;
  for (let k = 0; k < 3; k++) {
    const p = ((t + k * 1.2) % 3.6) / 3.6;
    paintRing(ctx, mid, water + PX, 30 + p * (w * 0.42), (1 - p) * 0.45 * (t > 0.6 ? 1 : 0), green);
  }
  if (sink >= 1) {
    const b = (t * 0.8) % 1;
    ctx.fillStyle = green;
    ctx.globalAlpha = 1 - b;
    ctx.fillRect(mid + 2 * PX, water - Math.round(b * 5) * PX, PX, PX);
    ctx.globalAlpha = 1;
  }
}

/** "2h 14m", "37m" or "<1m". */
export function formatLeft(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

export type PondKind = "ended" | "limit";

/** Starts the scene on `canvas`, sized by `box`: animation, pausing while hidden, redraws on resize and theme change. Returns the cleanup. */
export function runPondScene(box: HTMLElement, canvas: HTMLCanvasElement, kind: PondKind, { hidden }: { hidden: boolean }): () => void {
  const still = reducedMotion();
  let frame = 0;
  let t0 = performance.now();
  let last = 0;
  let fly = "";
  const size = () => {
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [box.clientWidth, box.clientHeight];
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return [w, h] as const;
  };
  const draw = () => {
    const [w, h] = size();
    if (w === 0) return;
    paintScene(canvas, kind, last, w, h, still, fly);
  };
  const tick = () => {
    last = (performance.now() - t0) / 1000;
    draw();
    // The sinking scene ends on a still frame; the pond keeps going while it's seen.
    if (kind === "ended" && last >= SETTLE_S) return;
    frame = requestAnimationFrame(tick);
  };
  const readColors = () => {
    // The desktop names its muted color --fg-muted, the phone --muted.
    const style = getComputedStyle(canvas);
    fly = style.getPropertyValue("--fg-muted").trim() || style.getPropertyValue("--muted").trim() || "#999";
  };
  readColors();
  const start = () => {
    cancelAnimationFrame(frame);
    if (still || hidden || document.hidden) return;
    // Back from a pause: the sinking scene resumes where it was.
    t0 = performance.now() - last * 1000;
    if (kind === "ended" && last >= SETTLE_S) return;
    frame = requestAnimationFrame(tick);
  };
  draw();
  start();
  const onVisibility = () => (document.hidden ? cancelAnimationFrame(frame) : start());
  document.addEventListener("visibilitychange", onVisibility);
  // A resize or a theme change redraws the current frame (the loop does it by itself while it runs).
  const resize = new ResizeObserver(draw);
  resize.observe(box);
  const theme = new MutationObserver(() => {
    readColors();
    draw();
  });
  theme.observe(document.documentElement, { attributes: true });
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisibility);
    resize.disconnect();
    theme.disconnect();
  };
}
