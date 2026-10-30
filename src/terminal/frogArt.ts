// The Flowcode frog as pixel art: its shape, poses and colors (from the theme's
// --accent). No imports, so the phone app can draw it too.

export const FROG_WIDTH = 15;
export const FROG_HEIGHT = 6;
/** The frog's drawing area in its own units (the catch's SVG viewBox, with room
 * above the head for a hop): one pixel is about 19 x 20 units, half a cell. */
export const FROG_BOX = { x: 130, y: 205, width: 764, height: 650 };

/** The frog's colors: its body, the dark of its pupils and `>_`, and the
 * white of its eyes. */
interface FrogPalette {
  green: string;
  dark: string;
  white: string;
}

type Hsl = [h: number, s: number, l: number];

function hexToHsl(hex: string): Hsl | null {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((c) => parseInt(c, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r, g, b]
    .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** The logo's own colors, for when the theme's accent can't be read. */
const FALLBACK = {
  rest: { green: "AAC67D", dark: "2A4434", white: "EBEBEB" },
  awake: { green: "A3E635", dark: "14532D", white: "FFFFFF" },
};
let themeCache: { accent: string; colors: typeof FALLBACK } | null = null;

/** The frog's colors from the theme's accent - the wordmark's color - at
 * rest and awake: at rest its body is the accent itself, so it sits with
 * the wordmark; awake it's livelier (more saturated, a middling lightness)
 * - unless the accent is a grey, which stays grey. The dark parts are the
 * accent's hue, deep; the eyes' white is a touch dimmer at rest. */
function themeColors(scope: Element): typeof FALLBACK {
  const accent = getComputedStyle(scope).getPropertyValue("--accent").trim();
  if (themeCache?.accent === accent) return themeCache.colors;
  const hsl = hexToHsl(accent);
  let colors = FALLBACK;
  if (hsl) {
    const [h, s, l] = hsl;
    const grey = s < 0.08;
    const lively: Hsl = grey ? [h, s, l] : [h, Math.min(1, s + 0.35), Math.min(0.65, Math.max(0.45, l))];
    colors = {
      rest: { green: hslToHex([h, s, l]), dark: hslToHex([h, s, Math.max(0.1, l * 0.35)]), white: "EBEBEB" },
      awake: {
        green: hslToHex(lively),
        dark: hslToHex([h, grey ? s : Math.min(1, s + 0.2), Math.max(0.1, lively[2] * 0.3)]),
        white: "FFFFFF",
      },
    };
  }
  themeCache = { accent, colors };
  return colors;
}

/** The frog's colors `vivid` (0-1) of the way from resting to awake, from
 * the accent in effect at `scope` - a terminal can have its own palette. */
export function frogPalette(vivid = 0, scope: Element = document.documentElement): FrogPalette {
  const { rest, awake } = themeColors(scope);
  if (vivid <= 0) return rest;
  if (vivid >= 1) return awake;
  const mix = (a: string, b: string) =>
    [0, 2, 4]
      .map((i) => {
        const from = parseInt(a.slice(i, i + 2), 16);
        const to = parseInt(b.slice(i, i + 2), 16);
        return Math.round(from + (to - from) * vivid)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
      .toUpperCase();
  return {
    green: mix(rest.green, awake.green),
    dark: mix(rest.dark, awake.dark),
    white: mix(rest.white, awake.white),
  };
}

/** How the frog stands: where its pupils look (units, up to ~30 each way),
 * how far its lids are down (0 open - 1 shut), the body's scale, rotation
 * (degrees) and lift (units, up is negative) around its bottom center, and
 * whether the `_` cursor on its belly is lit. The terminal always shows
 * REST_POSE; the New Tab page animates the rest. */
export interface FrogPose {
  lookX: number;
  lookY: number;
  lid: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  lift: number;
  cursor: boolean;
  /** How far (0-1) it's drawn in the logo's own colors rather than the
   * resting ones - the New Tab's frog, waking up and dozing off. */
  vivid?: number;
}

export const REST_POSE: FrogPose = { lookX: 0, lookY: 6, lid: 0, scaleX: 1, scaleY: 1, rotate: 0, lift: 0, cursor: true };

/** The Flowcode frog (two eye circles over an oval body - the numbers of the
 * old SVG logo, viewBox 130 245 764 610) at a point, in `pose`. No outline: a
 * dark outline drawn as a foreground color against the terminal's own
 * background would get repainted by xterm's minimumContrastRatio. */
function frogPixel(px: number, py: number, pose: FrogPose, palette: FrogPalette): string | null {
  const { green: FROG_GREEN, dark: FROG_DARK, white: FROG_WHITE } = palette;
  // Undo the body's transform around its bottom center to find the point
  // on the frog at rest.
  const ox = 512;
  const oy = 830;
  const angle = (-pose.rotate * Math.PI) / 180;
  const dx = px - ox;
  const dy = py - pose.lift - oy;
  const x = ox + (dx * Math.cos(angle) - dy * Math.sin(angle)) / pose.scaleX;
  const y = oy + (dx * Math.sin(angle) + dy * Math.cos(angle)) / pose.scaleY;

  const segment = (ax: number, ay: number, bx: number, by: number) => {
    const sx = bx - ax;
    const sy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)));
    return Math.hypot(x - (ax + t * sx), y - (ay + t * sy));
  };
  for (const cx of [340, 684]) {
    // The lid comes down from the top of the eye, as far as `lid` says.
    if (pose.lid > 0 && Math.hypot(x - cx, y - 393) <= 89 && y <= 304 + 178 * pose.lid) return FROG_GREEN;
    // The glint is a bit larger than the logo's so it survives this size.
    if (Math.hypot(x - (cx + 14 + pose.lookX), y - 378 - pose.lookY) <= 16) return FROG_WHITE;
    if (Math.hypot(x - (cx + pose.lookX), y - 393 - pose.lookY) <= 45) return FROG_DARK;
    if (Math.hypot(x - cx, y - 393) <= 85) return FROG_WHITE;
  }
  const strokes: [number, number, number, number][] = [
    [396, 575, 472, 632],
    [472, 632, 396, 689],
  ];
  if (pose.cursor) strokes.push([526, 689, 636, 689]);
  if (strokes.some((s) => segment(...s) <= 24)) return FROG_DARK;
  const body =
    Math.hypot(x - 340, y - 400) <= 135 ||
    Math.hypot(x - 684, y - 400) <= 135 ||
    ((x - 512) / 360) ** 2 + ((y - 610) / 220) ** 2 <= 1;
  return body ? FROG_GREEN : null;
}

/** The frog in `pose` as a `width` x `height` grid of pixels over FROG_BOX,
 * row by row: each one's color (hex, no `#`) or null where there's no frog.
 * See FROG_PIXELS for the grid the terminal and the New Tab page draw. */
export function frogPixels(
  pose: FrogPose,
  width: number,
  height: number,
  scope: Element = document.documentElement,
): (string | null)[] {
  const out: (string | null)[] = [];
  const palette = frogPalette(pose.vivid, scope);
  for (let row = 0; row < height; row++) {
    const y = FROG_BOX.y + ((row + 0.5) * FROG_BOX.height) / height;
    for (let col = 0; col < width; col++) {
      out.push(frogPixel(FROG_BOX.x + ((col + 0.5) * FROG_BOX.width) / width, y, pose, palette));
    }
  }
  return out;
}

/** The frog's pixel grid, over its FROG_WIDTH x FROG_HEIGHT cells: two
 * pixels across and four down a cell, near enough square - finer than the
 * half blocks a terminal could print. */
export const FROG_PIXELS = { width: FROG_WIDTH * 2, height: FROG_HEIGHT * 4 };

/** The frog in `pose` onto `canvas`, `width` x `height` CSS px: FROG_PIXELS
 * squares, snapped to device pixels so they stay crisp. */
export function drawFrog(canvas: HTMLCanvasElement, pose: FrogPose, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  const { width: cols, height: rows } = FROG_PIXELS;
  // In the colors of the palette where the canvas is.
  const pixels = frogPixels(pose, cols, rows, canvas);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round((r * h) / rows);
    const y1 = Math.round(((r + 1) * h) / rows);
    for (let c = 0; c < cols; c++) {
      const color = pixels[r * cols + c];
      if (!color) continue;
      const x0 = Math.round((c * w) / cols);
      ctx.fillStyle = `#${color}`;
      ctx.fillRect(x0, y0, Math.round(((c + 1) * w) / cols) - x0, y1 - y0);
    }
  }
}
