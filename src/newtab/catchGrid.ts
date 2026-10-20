import { useLayoutEffect, useState, type CSSProperties } from "react";
import { FROG_BOX, FROG_HEIGHT, FROG_WIDTH, TAGLINE_LINE, lastTermGrid } from "../terminal/asciiBanner";
import type { CatchFrame, FlyArea } from "./useFrogPose";
import { MOUTH, sceneBounds, sceneRgb, toWorld, tongueTip } from "./frog3d";

/** The terminal's font (see Terminal.tsx) - the page's banner and prompt are
 * set in it so they line up cell for cell with what replaces them. */
const TERM_FONT = "Menlo, Consolas, monospace";
/** What a terminal's columns leave out of its width: `.terminal-container`'s
 * horizontal padding (terminal.css) and the scrollbar FitAddon reserves. */
const TERM_GUTTER_X = 28 + 14;
interface Segment {
  text: string;
  style: CSSProperties;
}

/** The banner exactly as the terminal will draw it: `buildAsciiBanner`'s own
 * output, read back into styled runs per line. Understands what that output
 * uses - SGR reset, dim, truecolor (and the cyan fallback) foreground and
 * background, and the absolute column move that places the frog. */
export function bannerLines(ansi: string): Segment[][] {
  return ansi
    .replace(/\r\n$/, "")
    .split("\r\n")
    .map((line) => {
      const segments: Segment[] = [];
      let style: CSSProperties = {};
      let width = 0;
      let last = 0;
      const push = (text: string) => {
        if (!text) return;
        segments.push({ text, style });
        width += [...text].length;
      };
      for (const match of line.matchAll(/\x1b\[([0-9;]*)([mG])/g)) {
        push(line.slice(last, match.index));
        last = match.index! + match[0].length;
        const params = match[1].split(";").map(Number);
        if (match[2] === "G") {
          const pad = (params[0] || 1) - 1 - width;
          if (pad > 0) {
            const keep = style;
            style = {};
            push(" ".repeat(pad));
            style = keep;
          }
          continue;
        }
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p === 0) style = {};
          else if (p === 2) style = { ...style, opacity: 0.55 };
          else if (p === 36) style = { ...style, color: "var(--accent)" };
          else if ((p === 38 || p === 48) && params[i + 1] === 2) {
            const rgb = `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`;
            style = p === 38 ? { ...style, color: rgb } : { ...style, background: rgb };
            i += 4;
          }
        }
      }
      push(line.slice(last));
      return segments;
    });
}

/** Drawing units per pixel of the frog (two pixels per character cell). */
export const UNIT_X = FROG_BOX.width / FROG_WIDTH;
export const UNIT_Y = FROG_BOX.height / (FROG_HEIGHT * 2);

/** "Fly" in the app's languages: typed on the prompt, the frog eats it. */
export const FLY_WORDS = /(?<![\p{L}\p{N}_-])(mosca|mosche|fly|flies)(?![\p{L}\p{N}_-])/giu;
/** How long the line has to sit still before the frog goes for the word -
 * never mid-typing. */
export const FLY_WORD_IDLE_MS = 700;

/** A fly word on `line` the frog may eat: not one that's the command of a
 * longer line (`fly deploy` runs Fly.io's CLI), so only a word on its own
 * or among a command's arguments. */
export function flyWordIn(line: string): { word: string; index: number } | null {
  for (const match of line.matchAll(FLY_WORDS)) {
    const index = match.index!;
    const isCommand = line.slice(0, index).trim() === "" && line.slice(index + match[0].length).trim() !== "";
    if (!isCommand) return { word: match[0], index };
  }
  return null;
}

/** The page's cell grid, as the catch sees it: where cell (0, 0) is on
 * screen, the cell size, and where the frog's box sits in it. */
export interface CatchGrid {
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  frogAt: { col: number; top: number };
}

/** A cell column / pixel row (two per cell row) in the frog's drawing units. */
const toUnits = (g: CatchGrid, col: number, pixelRow: number) => ({
  x: FROG_BOX.x + (col - g.frogAt.col + 0.5) * UNIT_X,
  y: FROG_BOX.y + (pixelRow - 2 * g.frogAt.top + 0.5) * UNIT_Y,
});

/** Things on the page the fly can land on, besides the banner's: the
 * prompt, the list's headings and names, the shell buttons, the key hints. */
const LANDING_SELECTORS = [".newtab-ps", ".newtab-heading", ".newtab-row-name", ".newtab-chip", ".newtab-keys"];

/** Where the fly can go: spots on top of the wordmark's letters, the
 * tagline, the system table's top edge and the page's own elements - one
 * group each - and the visible page to flutter about in. */
export function flyArea(g: CatchGrid, lines: Segment[][], root: HTMLElement): FlyArea {
  const groups: { x: number; y: number }[][] = [];
  const onLine = (line: number, test: (ch: string) => boolean) => {
    const cells = toCells(lines[line] ?? []);
    return cells.flatMap((c, col) => (test(c.ch) ? [toUnits(g, col, 2 * line)] : []));
  };
  // The wordmark's top row of blocks, the tagline under it, the table's top.
  groups.push(onLine(1, (ch) => ch === "\u2588"));
  groups.push(onLine(TAGLINE_LINE, (ch) => ch !== " "));
  const tableTop = lines.findIndex((l) => toCells(l).some((c) => c.ch === "\u250c"));
  if (tableTop >= 0) groups.push(onLine(tableTop, (ch) => ch === "\u2500"));
  for (const selector of LANDING_SELECTORS) {
    const spots: { x: number; y: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const row = Math.floor((2 * (r.top + r.height / 2 - g.originY)) / g.cellHeight / 2) * 2;
      if (row < 0 || row >= 2 * g.rows) continue;
      const from = Math.round((r.left - g.originX) / g.cellWidth);
      const to = Math.round((r.right - g.originX) / g.cellWidth) - 1;
      for (let col = Math.max(1, from); col <= Math.min(g.cols - 2, to); col++) spots.push(toUnits(g, col, row));
    }
    groups.push(spots);
  }
  const corner = toUnits(g, 2, 0);
  const far = toUnits(g, g.cols - 3, 2 * g.rows - 2);
  return { spots: groups, bounds: { left: corner.x, right: far.x, top: corner.y, bottom: far.y } };
}

interface Cell {
  ch: string;
  style: CSSProperties;
}

function toCells(segments: Segment[]): Cell[] {
  return segments.flatMap((s) => [...s.text].map((ch) => ({ ch, style: s.style })));
}

/** A frame of the real-frog catch onto `canvas`, over the whole page, under
 * the pixel-art catch (which fades out over it as the frog turns real): the scene
 * ray-traced at a few px - with bands slipping sideways while it glitches -
 * plus a soft shadow under it. */
export function drawRealCatch(canvas: HTMLCanvasElement, g: CatchGrid, frame: CatchFrame) {
  const real = frame.real!;
  const width = g.cols * g.cellWidth;
  const height = g.rows * g.cellHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Drawing units <-> page px.
  const pxPerUnitX = g.cellWidth / UNIT_X;
  const pxPerUnitY = g.cellHeight / (2 * UNIT_Y);
  const toPxX = (x: number) => (g.frogAt.col + (x - FROG_BOX.x) / UNIT_X) * g.cellWidth;
  const toPxY = (y: number) => (g.frogAt.top + (y - FROG_BOX.y) / (2 * UNIT_Y)) * g.cellHeight;
  const toUnitX = (px: number) => FROG_BOX.x + (px / g.cellWidth - g.frogAt.col) * UNIT_X;
  const toUnitY = (py: number) => FROG_BOX.y + (py / g.cellHeight - g.frogAt.top) * 2 * UNIT_Y;

  const scene = frame.scene;
  // A soft shadow on the ground under it, fainter the higher it hops.
  if (real.amount > 0) {
    const gx = toPxX(512 + scene.shiftX);
    const gy = toPxY(840);
    const rx = 330 * pxPerUnitX;
    const ry = 40 * pxPerUnitY;
    const shadow = ctx.createRadialGradient(gx, gy, 0, gx, gy, rx);
    shadow.addColorStop(0, `rgba(0, 0, 0, ${0.35 * real.amount * (1 + scene.lift / 200)})`);
    shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(1, ry / rx);
    ctx.translate(-gx, -gy);
    ctx.fillStyle = shadow;
    ctx.fillRect(gx - rx, gy - rx, rx * 2, rx * 2);
    ctx.restore();
  }

  // Not the screen's own pixels: ray-tracing those is too slow in a frame,
  // and smoothed up from a few px it reads as a real, soft image anyway.
  const stepX = 3;
  const stepY = 3;
  const box = sceneBounds(scene);
  const x0 = Math.max(0, Math.floor(toPxX(box.left) / stepX) * stepX);
  const y0 = Math.max(0, Math.floor(toPxY(box.top) / stepY) * stepY);
  const x1 = Math.min(width, toPxX(box.right));
  const y1 = Math.min(height, toPxY(box.bottom));
  const nx = Math.max(1, Math.ceil((x1 - x0) / stepX));
  const ny = Math.max(1, Math.ceil((y1 - y0) / stepY));
  const image = new ImageData(nx, ny);
  // Only rays near the frog's own box or along its tongue can hit anything.
  const own = sceneBounds({ ...scene, tongue: null });
  const tip = tongueTip(scene);
  const [mx, my] = toWorld(MOUTH, scene);
  const [tx, ty] = tip ? toWorld(tip, scene) : [mx, my];
  const nearTongue = (x: number, y: number) => {
    if (!tip) return false;
    const [sx, sy] = [tx - mx, ty - my];
    const u = Math.max(0, Math.min(1, ((x - mx) * sx + (y - my) * sy) / (sx * sx + sy * sy || 1)));
    return Math.hypot(x - (mx + u * sx), y - (my + u * sy)) < 60;
  };
  for (let j = 0; j < ny; j++) {
    const y = toUnitY(y0 + (j + 0.5) * stepY);
    for (let i = 0; i < nx; i++) {
      const x = toUnitX(x0 + (i + 0.5) * stepX);
      if (!(x >= own.left && x <= own.right && y >= own.top && y <= own.bottom) && !nearTongue(x, y)) continue;
      const c = sceneRgb(x, y, scene);
      if (!c) continue;
      const o = (j * nx + i) * 4;
      image.data[o] = c[0];
      image.data[o + 1] = c[1];
      image.data[o + 2] = c[2];
      image.data[o + 3] = 255;
    }
  }
  const buffer = document.createElement("canvas");
  buffer.width = nx;
  buffer.height = ny;
  buffer.getContext("2d")!.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (real.glitch > 0.08) {
    // Glitching: horizontal bands of it slip sideways, a few each frame.
    const bands = 6 + Math.floor(real.glitch * 10);
    for (let b = 0; b < bands; b++) {
      const sy = (b / bands) * ny;
      const sh = ny / bands;
      const slip = Math.random() < real.glitch * 0.6 ? (Math.random() - 0.5) * 40 * real.glitch : 0;
      ctx.drawImage(buffer, 0, sy, nx, sh, x0 + slip, y0 + sy * stepY, nx * stepX, sh * stepY);
    }
  } else {
    ctx.drawImage(buffer, x0, y0, nx * stepX, ny * stepY);
  }
}

/** The terminal's cell grid at `width`: the last terminal's own measurements
 * when it was laid out at this font size (and its column count when at this
 * very width), otherwise the font measured here the way xterm measures it. */
export function useTermGrid(fontSize: number, width: number) {
  const [measured, setMeasured] = useState<{ fontSize: number; cellWidth: number; cellHeight: number } | null>(null);
  const grid = lastTermGrid();
  const known = grid && grid.fontSize === fontSize ? grid : null;
  useLayoutEffect(() => {
    if (known || measured?.fontSize === fontSize) return;
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${TERM_FONT};font-size:${fontSize}px;line-height:normal`;
    probe.textContent = "W".repeat(32);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    setMeasured({ fontSize, cellWidth: rect.width / 32, cellHeight: Math.ceil(rect.height) });
  }, [known, measured, fontSize]);
  const cell = known ?? (measured?.fontSize === fontSize ? measured : null);
  if (!cell || width <= 0) return null;
  const cols =
    known && Math.abs(known.width - width) < 1 ? known.cols : Math.max(1, Math.floor((width - TERM_GUTTER_X) / cell.cellWidth));
  return { cols, cellWidth: cell.cellWidth, cellHeight: cell.cellHeight };
}
