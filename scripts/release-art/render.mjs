// Renders the 8-bit release covers to site/assets/releases/<name>.png
// (1600x900, a 160x90 pixel grid scaled 10x).
//   node scripts/release-art/render.mjs            -> every cover
//   node scripts/release-art/render.mjs v0.38.0    -> one cover
// A new release = a new entry in COVERS below, drawn on the shared night pond.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canvas, curve, frog, rng, savePng, text, W, H } from "./pixel.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../site/assets/releases");

const C = {
  sky: ["#0e0a14", "#130e1c", "#1a1325", "#22182d", "#2c1e33"],
  star: "#e8dcc0", starDim: "#7d7090",
  moon: "#f1e3c0", moonShade: "#cdbb8e",
  hill: "#141c18", trees: "#0d140f", treesTop: "#16241a",
  water: ["#0c1418", "#0f1a1f", "#122027"], ripple: "#25404a", rippleHi: "#3c6470", glint: "#d9c999",
  pad: "#3f6b34", padHi: "#5f9148", padDark: "#27461f", padVein: "#335a2b",
  reed: "#24361d", reedHi: "#36502a", cattail: "#6b4a2c",
  fly: "#e6f59a", flyGlow: "#5c6a2c",
  ink: "#e7d8c5", inkDim: "#8a7a66", shadow: "#060407",
  moss: "#9db984", amber: "#e0b45f",
  screen: "#0f1d14", screenEdge: "#5d5a52", screenEdgeDark: "#34322d", prompt: "#9fe07a",
};

const HORIZON = 54;

/** The shared scene: banded night sky with stars and a moon, a treeline, and the pond. */
function nightPond(seed = 7) {
  const c = canvas(W, H, C.sky[0]);
  const r = rng(seed);
  c.bands(0, HORIZON, C.sky);
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(r() * W), y = Math.floor(r() * (HORIZON - 14));
    c.set(x, y, r() < 0.3 ? C.star : C.starDim);
  }
  // a couple of twinkly cross stars
  for (const [x, y] of [[44, 9], [101, 20]]) { c.set(x, y, C.star); c.set(x - 1, y, C.starDim); c.set(x + 1, y, C.starDim); c.set(x, y - 1, C.starDim); c.set(x, y + 1, C.starDim); }
  // moon with a shaded edge and two craters
  c.ellipse(134, 15, 8, 8, (x, y, dx, dy) => (dx + dy > 0.7 ? C.moonShade : C.moon));
  c.set(131, 13, C.moonShade); c.set(132, 13, C.moonShade); c.set(136, 18, C.moonShade);
  // far hills and a jagged treeline
  for (let x = 0; x < W; x++) {
    const hill = HORIZON - 6 - Math.round(3 * Math.sin(x / 17) + 2 * Math.sin(x / 7 + 1));
    for (let y = hill; y < HORIZON; y++) c.set(x, y, C.hill);
    const tree = HORIZON - 3 - Math.round(Math.abs(Math.sin(x * 0.9)) * 4 + (x % 11 < 3 ? 3 : 0));
    for (let y = tree; y < HORIZON; y++) c.set(x, y, y === tree ? C.treesTop : C.trees);
  }
  // water
  c.bands(HORIZON, H, C.water);
  for (let i = 0; i < 26; i++) {
    const y = HORIZON + 2 + Math.floor(r() * (H - HORIZON - 3));
    const x = Math.floor(r() * W), len = 3 + Math.floor(r() * 9);
    c.hline(x, x + len, y, r() < 0.25 ? C.rippleHi : C.ripple);
  }
  // the moon's reflection: broken bright dashes under it
  for (let k = 0; k < 7; k++) {
    const y = HORIZON + 2 + k * 3, half = 5 - Math.floor(k / 2);
    c.hline(134 - half + (k % 2), 134 + half - (k % 3), y, k < 3 ? C.glint : C.rippleHi);
  }
  return c;
}

/** A lily pad (with its notch) at cx,cy. */
function lilyPad(c, cx, cy, rx, ry, notch = 1) {
  c.ellipse(cx, cy + 1, rx, ry, C.padDark);
  c.ellipse(cx, cy, rx, ry, (x, y, dx, dy) => {
    const ang = Math.atan2(dy, dx * notch);
    if (ang > -0.35 && ang < 0.15 && dx > 0) return null; // notch
    if (dy < -0.45) return C.padHi;
    if (Math.abs(dy) < 0.12 && dx < 0) return C.padVein;
    return C.pad;
  });
  // the notch shows the water under it
  for (let x = Math.round(cx); x <= cx + rx; x++) {
    const y = Math.round(cy - (x - cx) * 0.18);
    c.set(x, y, C.water[1]);
  }
}

/** A reed clump with a cattail, rooted at x,y. */
function reeds(c, x, y, h, lean = 1) {
  for (let k = 0; k < 4; k++) {
    const bx = x + k * 2, top = y - h + k * 3;
    for (let yy = y; yy > top; yy--) c.set(bx + Math.round(((y - yy) / h) * lean * (k - 1)), yy, k % 2 ? C.reedHi : C.reed);
  }
  c.rect(x + 2 + lean, y - h - 3, 2, 4, C.cattail);
}

/** A firefly: bright pixel with a dim halo. */
function firefly(c, x, y) { c.set(x - 1, y, C.flyGlow); c.set(x + 1, y, C.flyGlow); c.set(x, y - 1, C.flyGlow); c.set(x, y + 1, C.flyGlow); c.set(x, y, C.fly); }

/** A tiny CRT terminal showing `>_`, bottom-centre at x,y. */
function terminal(c, x, y, lit = true) {
  const w = 11, h = 8, left = x - Math.floor(w / 2), top = y - h;
  c.rect(left, top, w, h, C.screenEdge);
  c.hline(left, left + w - 1, top + h - 1, C.screenEdgeDark);
  c.rect(left + 1, top + 1, w - 2, h - 3, C.screen);
  if (lit) {
    c.set(left + 2, top + 2, C.prompt); c.set(left + 3, top + 3, C.prompt); c.set(left + 2, top + 4, C.prompt);
    c.hline(left + 5, left + 7, top + 4, C.prompt);
  }
  c.rect(x - 1, y, 3, 1, C.screenEdgeDark);
}

function wordmark(c, version) {
  text(c, "FLOWCODE", 8, 8, C.inkDim, { shadow: C.shadow });
  if (version) text(c, version, 8, 18, C.ink, { scale: 2, gap: 1, shadow: C.shadow });
}

const COVERS = {
  /** Releases without their own art: the frog resting on a pad under the moon. */
  generic() {
    const c = nightPond(7);
    wordmark(c, null);
    reeds(c, 10, 80, 18, -1); reeds(c, 18, 84, 13, 1); reeds(c, 141, 82, 16, 1); reeds(c, 148, 86, 12, -1);
    lilyPad(c, 42, 76, 9, 3); lilyPad(c, 118, 70, 7, 2);
    lilyPad(c, 80, 74, 24, 6);
    // ripples around the big pad
    c.hline(52, 58, 82, C.rippleHi); c.hline(101, 109, 81, C.rippleHi); c.hline(60, 98, 84, C.ripple);
    frog(c, 65, 50);
    for (const [x, y] of [[30, 44], [57, 36], [104, 41], [122, 52], [92, 30]]) firefly(c, x, y);
    return c;
  },

  /** 0.38.0 "Agents everywhere, chats in a blink": pads carry terminals linked by
   * delegation dots; the frog leaps from pad to pad. */
  "v0.38.0"() {
    const c = nightPond(38);
    wordmark(c, "0.38");
    reeds(c, 4, 84, 16, 1); reeds(c, 150, 85, 14, -1);
    const pads = [[30, 74, 15, 4], [79, 80, 17, 5], [126, 72, 14, 4], [104, 61, 9, 3], [56, 63, 9, 3]];
    // delegation threads (dotted, moss and amber) between the terminals
    c.dots(curve(30, 64, 40, 50, 56, 55), 2, C.moss);
    c.dots(curve(56, 55, 80, 66, 104, 53), 2, C.amber);
    c.dots(curve(104, 53, 118, 50, 126, 62), 2, C.moss);
    for (const [x, y, rx, ry] of pads) lilyPad(c, x, y, rx, ry);
    terminal(c, 30, 72); terminal(c, 126, 70); terminal(c, 104, 60, false); terminal(c, 56, 62);
    // the leap: dotted arc from the big pad up and over, frog at its top
    c.dots(curve(80, 74, 82, 46, 99, 40), 3, C.ink);
    for (const [x, y, l] of [[93, 28, 5], [92, 32, 7]]) c.hline(x - l, x - 1, y, C.inkDim);
    frog(c, 96, 20, { cols: 26, rows: 21 });
    for (const [x, y] of [[20, 40], [70, 34], [140, 45]]) firefly(c, x, y);
    return c;
  },
};

const only = process.argv[2];
for (const [name, draw] of Object.entries(COVERS)) {
  if (only && only !== name) continue;
  savePng(draw(), join(OUT, `${name}.png`));
  console.log(`wrote site/assets/releases/${name}.png`);
}
