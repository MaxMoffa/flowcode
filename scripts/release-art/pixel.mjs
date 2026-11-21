// Tiny pixel-art toolkit for the release covers: a low-res grid of colors,
// drawing helpers, the Flowcode frog (same geometry as src/terminal/frogArt.ts),
// a 5x7 pixel font, and a dependency-free PNG writer that scales the grid up
// with hard edges (nearest neighbour).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

export const W = 160;
export const H = 90;

export function canvas(w = W, h = H, fill = "#000000") {
  const px = new Array(w * h).fill(fill);
  const c = {
    w, h, px,
    set(x, y, col) {
      x = Math.round(x); y = Math.round(y);
      if (col && x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = col;
    },
    get: (x, y) => px[y * w + x],
    rect(x, y, rw, rh, col) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) c.set(x + i, y + j, col); },
    hline(x0, x1, y, col) { for (let x = x0; x <= x1; x++) c.set(x, y, col); },
    /** Filled ellipse; `fn(x, y, dx, dy)` may return a color per pixel. */
    ellipse(cx, cy, rx, ry, col) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) c.set(x, y, typeof col === "function" ? col(x, y, dx, dy) : col);
        }
    },
    /** Vertical bands between colors, with a 2x2 ordered dither at each seam (8-bit sky). */
    bands(y0, y1, cols) {
      const n = cols.length, span = (y1 - y0) / n;
      for (let y = y0; y < y1; y++) {
        const t = (y - y0) / span, i = Math.min(n - 1, Math.floor(t)), f = t - i;
        for (let x = 0; x < w; x++) {
          const next = cols[Math.min(n - 1, i + 1)];
          const bayer = [[0, 2], [3, 1]][y % 2][x % 2] / 4;
          c.set(x, y, f > 0.75 && bayer < (f - 0.75) * 4 ? next : cols[i]);
        }
      }
    },
    /** Dotted pixel line (every `step` px) between two points. */
    dots(points, step, col) {
      let acc = 0;
      for (let k = 1; k < points.length; k++) {
        const [ax, ay] = points[k - 1], [bx, by] = points[k];
        const len = Math.max(1, Math.hypot(bx - ax, by - ay));
        for (let s = 0; s < len; s++) { if (acc++ % step === 0) c.set(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len, col); }
      }
    },
    line(ax, ay, bx, by, col) {
      const len = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
      for (let s = 0; s <= len; s++) c.set(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len, col);
    },
  };
  return c;
}

/** Points along a quadratic curve, for arcs. */
export function curve(ax, ay, qx, qy, bx, by, n = 60) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * ax + 2 * u * t * qx + t * t * bx, u * u * ay + 2 * u * t * qy + t * t * by]);
  }
  return pts;
}

// ---- frog (port of frogPixel in src/terminal/frogArt.ts) ----
export const FROG = { green: "#aac67d", dark: "#2a4434", white: "#ebebeb" };
const BOX = { x: 130, y: 205, width: 764, height: 650 };

function frogAt(x, y, pal, look = [0, 6], cursor = true) {
  const seg = (ax, ay, bx, by) => {
    const sx = bx - ax, sy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)));
    return Math.hypot(x - (ax + t * sx), y - (ay + t * sy));
  };
  for (const cx of [340, 684]) {
    if (Math.hypot(x - (cx + 14 + look[0]), y - 378 - look[1]) <= 16) return pal.white;
    if (Math.hypot(x - (cx + look[0]), y - 393 - look[1]) <= 45) return pal.dark;
    if (Math.hypot(x - cx, y - 393) <= 85) return pal.white;
  }
  const strokes = [[396, 575, 472, 632], [472, 632, 396, 689]];
  if (cursor) strokes.push([526, 689, 636, 689]);
  if (strokes.some((s) => seg(...s) <= 24)) return pal.dark;
  const body = Math.hypot(x - 340, y - 400) <= 135 || Math.hypot(x - 684, y - 400) <= 135 || ((x - 512) / 360) ** 2 + ((y - 610) / 220) ** 2 <= 1;
  return body ? pal.green : null;
}

/** The frog as a cols x rows sprite (30 x 24 is the terminal's grid), top-left at x,y. */
export function frog(c, x, y, { cols = 30, rows = 24, pal = FROG, look, cursor = true, flip = false } = {}) {
  for (let r = 0; r < rows; r++) {
    const fy = BOX.y + ((r + 0.5) * BOX.height) / rows;
    for (let k = 0; k < cols; k++) {
      const fx = BOX.x + ((k + 0.5) * BOX.width) / cols;
      const col = frogAt(fx, fy, pal, look, cursor);
      if (col) c.set(x + (flip ? cols - 1 - k : k), y + r, col);
    }
  }
}

// ---- 5x7 pixel font ----
const GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  0: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ">": ["10000", "01000", "00100", "00010", "00100", "01000", "10000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
};

/** Text in the 5x7 font, `scale` pixels per font pixel, optional 1px drop shadow. */
export function text(c, str, x, y, col, { scale = 1, gap = 1, shadow } = {}) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[" "];
    for (let r = 0; r < 7; r++)
      for (let k = 0; k < 5; k++)
        if (g[r][k] === "1") {
          if (shadow) c.rect(cx + k * scale + 1, y + r * scale + 1, scale, scale, shadow);
        }
    for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === "1") c.rect(cx + k * scale, y + r * scale, scale, scale, col);
    cx += (5 + gap) * scale;
  }
  return cx;
}

// ---- PNG output ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Writes the canvas to `file` as an RGB PNG, each grid pixel `scale` x `scale`. */
export function savePng(c, file, scale = 10) {
  const ow = c.w * scale, oh = c.h * scale;
  const raw = Buffer.alloc((ow * 3 + 1) * oh);
  for (let y = 0; y < oh; y++) {
    const row = y * (ow * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < ow; x++) {
      const hex = c.px[Math.floor(y / scale) * c.w + Math.floor(x / scale)];
      const v = parseInt(hex.slice(1), 16);
      raw[row + 1 + x * 3] = v >> 16; raw[row + 2 + x * 3] = (v >> 8) & 255; raw[row + 3 + x * 3] = v & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** Deterministic pseudo-random numbers, so a cover renders the same every time. */
export function rng(seed = 1) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
