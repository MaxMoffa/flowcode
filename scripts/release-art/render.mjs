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

  /** 0.39.0 "The browser learns new tricks": a browser window on a big pad, framed by
   * the amber ring of agent control, a pixel cursor clicking its button, a download
   * arrow dropping into the pond; the frog on a side pad holds a compass. */
  "v0.39.0"() {
    const c = nightPond(39);
    wordmark(c, "0.39");
    reeds(c, 4, 85, 15, 1); reeds(c, 150, 86, 13, -1);
    lilyPad(c, 88, 82, 30, 6);
    lilyPad(c, 30, 76, 14, 4);
    lilyPad(c, 138, 70, 8, 3);
    // the browser window (x 62..115, y 36..77), amber agent ring around it
    const L = 62, T = 36, R = 115, B = 77;
    c.rect(L - 2, T - 2, R - L + 5, B - T + 5, C.amber);
    c.rect(L - 1, T - 1, R - L + 3, B - T + 3, C.shadow);
    c.rect(L, T, R - L + 1, B - T + 1, C.screenEdge);
    c.rect(L, T, R - L + 1, 6, C.screenEdgeDark);
    for (const [k, col] of [[0, "#e07a6a"], [1, C.amber], [2, C.moss]]) c.rect(L + 2 + k * 3, T + 2, 2, 2, col);
    c.rect(L + 13, T + 1, R - L - 15, 4, C.screen); // address bar
    c.hline(L + 15, L + 30, T + 3, C.inkDim);
    // page: heading, text lines, an input and a button
    c.rect(L + 1, T + 7, R - L - 1, B - T - 9, "#e9e2d4");
    c.rect(L + 5, T + 10, 24, 3, "#9a8f7e");
    for (const [y, w] of [[T + 16, 40], [T + 19, 33], [T + 22, 37]]) c.hline(L + 5, L + 5 + w, y, "#c9bfae");
    c.rect(L + 5, T + 26, 30, 5, "#ffffff"); c.hline(L + 5, L + 34, T + 31, "#b5ab9a");
    c.rect(L + 5, T + 33, 14, 5, "#3b6ea8"); // the button the agent clicks
    // agent highlight on the button + click ripple
    c.hline(L + 4, L + 19, T + 32, C.amber); c.hline(L + 4, L + 19, T + 38, C.amber);
    for (let y = T + 32; y <= T + 38; y++) { c.set(L + 4, y, C.amber); c.set(L + 19, y, C.amber); }
    for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [2, -2], [-2, 2]]) c.set(L + 14 + dx, T + 36 + dy, C.ink);
    // pixel cursor (arrow) on the button
    const cx = L + 14, cy = T + 36;
    const arrow = ["X", "XX", "XoX", "XooX", "XoooX", "XooooX", "XoooXX", "XXoX", "X XoX", "   XX"];
    arrow.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === "X") c.set(cx + i, cy + j, C.shadow); else if (ch === "o") c.set(cx + i, cy + j, C.amber); }));
    // downloads: an arrow dropping from the window into the pond, with a ripple
    const dx = R + 9;
    c.dots(curve(R - 2, T + 12, R + 12, T + 14, dx, T + 26), 2, C.moss);
    for (let y = T + 27; y < T + 36; y++) c.rect(dx - 1, y, 3, 1, C.moss);
    for (let k = 0; k < 4; k++) c.hline(dx - 4 + k, dx + 4 - k, T + 36 + k, C.moss);
    c.hline(dx - 6, dx + 6, T + 44, C.rippleHi); c.hline(dx - 9, dx + 9, T + 46, C.ripple);
    // the frog on the side pad, a compass at its feet
    frog(c, 18, 52, { cols: 22, rows: 18 });
    c.ellipse(46, 71, 5, 3, C.screenEdgeDark);
    c.ellipse(46, 70, 5, 3, (x, y, ddx, ddy) => (ddx * ddx + ddy * ddy > 0.55 ? C.amber : C.ink));
    c.set(46, 68, "#e07a6a"); c.set(46, 69, "#e07a6a"); c.set(46, 71, C.inkDim); c.set(46, 72, C.inkDim); c.set(46, 70, C.shadow);
    for (const [x, y] of [[22, 38], [130, 44], [143, 56], [52, 30]]) firefly(c, x, y);
    return c;
  },

  /** 0.39.1 "No more waiting after /clear": a phone on a pad shows a fresh, empty chat
   * with `/clear` sent and a green tick; the frog, done waiting, hops off the screen. */
  "v0.39.1"() {
    const c = nightPond(391);
    wordmark(c, "0.39.1");
    reeds(c, 6, 86, 14, 1); reeds(c, 148, 85, 12, -1);
    lilyPad(c, 95, 84, 24, 5);
    lilyPad(c, 134, 73, 13, 4);
    // the phone (x 82..107, y 38..81), right of the version number
    const L = 82, T = 38, R = 107, B = 81;
    c.rect(L - 1, T - 1, R - L + 3, B - T + 3, C.shadow);
    c.rect(L, T, R - L + 1, B - T + 1, C.screenEdgeDark);
    c.rect(L + 2, T + 4, R - L - 3, B - T - 8, C.screen);
    c.hline(L + 11, L + 16, T + 2, C.screenEdge); // speaker
    c.hline(L + 10, L + 17, B - 2, C.screenEdge); // home bar
    // the sent `/clear` bubble, top right
    c.rect(L + 10, T + 7, 14, 5, "#3b6ea8");
    for (let k = 0; k < 3; k++) c.set(L + 14 - k, T + 8 + k, C.ink); // "/"
    c.hline(L + 16, L + 22, T + 9, C.ink);
    // a fresh, empty conversation: a tick where the old chat was
    const tx = L + 13, ty = T + 26;
    for (const [dx, dy] of [[0, 0], [1, 1], [2, 2], [3, 1], [4, 0], [5, -1], [6, -2], [7, -3]]) c.rect(tx + dx, ty + dy, 2, 2, C.prompt);
    // empty composer at the bottom
    c.rect(L + 4, B - 10, R - L - 7, 4, C.screenEdgeDark);
    c.set(L + 6, B - 9, C.prompt); c.set(L + 6, B - 8, C.prompt);
    // the frog leaps off the phone toward the side pad, a dotted arc behind it
    c.dots(curve(R - 1, T + 18, 116, T - 6, 124, T + 4), 2, C.moss);
    frog(c, 122, 46, { cols: 20, rows: 16 });
    for (const [x, y] of [[24, 44], [60, 40], [150, 50], [66, 64]]) firefly(c, x, y);
    return c;
  },

  /** 0.40.0 "Tidy tabs, quick reconnects": a tabs drawer on a big pad sheds a batch of
   * tab cards into the pond, an amber undo arrow lifts one back; a phone on a side pad
   * sends signal arcs to it; the frog watches from the right. */
  "v0.40.0"() {
    const c = nightPond(40);
    wordmark(c, "0.40");
    reeds(c, 4, 86, 14, 1); reeds(c, 151, 86, 12, -1);
    lilyPad(c, 101, 84, 26, 5);
    lilyPad(c, 34, 82, 14, 4);
    lilyPad(c, 139, 70, 12, 4);
    // the tabs drawer (x 86..117, y 34..79): header with filter chips, two tabs left
    const L = 86, T = 34, R = 117, B = 79;
    c.rect(L - 1, T - 1, R - L + 3, B - T + 3, C.shadow);
    c.rect(L, T, R - L + 1, B - T + 1, C.screenEdge);
    c.rect(L + 1, T + 1, R - L - 1, B - T - 1, C.screen);
    c.rect(L + 3, T + 3, 7, 3, C.moss); c.rect(L + 12, T + 3, 7, 3, C.screenEdgeDark); c.rect(L + 21, T + 3, 7, 3, C.screenEdgeDark);
    const tab = (x, y, fav) => {
      c.rect(x, y, 26, 6, C.screenEdgeDark);
      c.rect(x + 2, y + 2, 2, 2, fav);
      c.hline(x + 6, x + 20, y + 3, C.inkDim);
    };
    tab(L + 3, T + 10, "#3b6ea8"); tab(L + 3, T + 18, C.amber);
    // empty space where the closed tabs were, dotted outline
    for (let x = L + 3; x <= L + 28; x += 2) { c.set(x, T + 27, C.screenEdgeDark); c.set(x, T + 41, C.screenEdgeDark); }
    // the swept tabs falling into the pond, each one further down and to the left
    for (const [x, y, fav] of [[62, 54, C.moss], [52, 66, "#e07a6a"], [64, 75, "#3b6ea8"]]) {
      c.rect(x - 1, y - 1, 18, 7, C.shadow);
      c.rect(x, y, 16, 5, C.screenEdge);
      c.rect(x + 2, y + 1, 2, 2, fav);
      c.hline(x + 6, x + 13, y + 2, C.screenEdgeDark);
    }
    c.hline(48, 60, 81, C.rippleHi); c.hline(44, 66, 83, C.ripple); c.hline(60, 82, 86, C.ripple);
    // the undo arrow: amber arc from a falling card back up into the drawer
    c.dots(curve(72, 52, 74, 32, L - 3, T + 33), 2, C.amber);
    for (const [dx, dy] of [[0, 0], [-1, -1], [-2, -2], [-1, 1], [-2, 2]]) c.set(L - 2 + dx, T + 33 + dy, C.amber);
    // the phone (x 27..41, y 48..79) with a ghost loader, signal arcs to the drawer
    const pl = 27, pt = 48, pr = 41, pb = 79;
    c.rect(pl - 1, pt - 1, pr - pl + 3, pb - pt + 3, C.shadow);
    c.rect(pl, pt, pr - pl + 1, pb - pt + 1, C.screenEdgeDark);
    c.rect(pl + 2, pt + 3, pr - pl - 3, pb - pt - 6, C.screen);
    for (const [y, w] of [[pt + 6, 8], [pt + 10, 6], [pt + 14, 9], [pt + 18, 5]]) c.hline(pl + 3, pl + 3 + w, y, C.screenEdge);
    c.hline(pl + 4, pl + 10, pb - 2, C.screenEdge);
    for (const [k, col] of [[0, C.moss], [1, C.moss], [2, C.prompt]]) {
      const r = 5 + k * 4;
      c.dots(curve(pr + 2, pt - r + 4, pr + r, pt - r, pr + r + 2, pt + 4), 2, col);
    }
    // the frog on the right pad, looking at the tidy drawer
    frog(c, 128, 52, { cols: 20, rows: 16 });
    for (const [x, y] of [[20, 40], [74, 36], [150, 52], [124, 40]]) firefly(c, x, y);
    return c;
  },

  /** 0.41.0 "Agents talk, computers team up": two pads, each with a terminal (two tabs, or two PCs),
   * a letter hopping between them along a dotted moss arc and the reply coming back on an amber one;
   * the frog sits on the small pad in the middle and watches the mail go by. */
  "v0.41.0"() {
    const c = nightPond(41);
    wordmark(c, "0.41");
    reeds(c, 4, 86, 14, 1); reeds(c, 151, 86, 12, -1);
    lilyPad(c, 34, 80, 18, 5);
    lilyPad(c, 126, 80, 18, 5);
    lilyPad(c, 80, 84, 11, 3);
    terminal(c, 34, 76); terminal(c, 126, 76);
    // the message: dotted arc from the left terminal to the right one, a letter at its top
    c.dots(curve(38, 64, 80, 30, 122, 64), 2, C.moss);
    const env = (x, y, col) => {
      c.rect(x - 1, y - 1, 13, 9, C.shadow);
      c.rect(x, y, 11, 7, C.ink);
      for (let k = 0; k < 5; k++) { c.set(x + k, y + k, col); c.set(x + 10 - k, y + k, col); }
    };
    env(74, 39, C.inkDim);
    // the reply: a lower amber arc back, a smaller letter on it
    c.dots(curve(120, 69, 80, 52, 40, 69), 2, C.amber);
    c.rect(56, 57, 7, 5, C.shadow); c.rect(57, 58, 5, 3, C.amber);
    // ripples under the pads
    c.hline(18, 30, 87, C.rippleHi); c.hline(110, 124, 87, C.rippleHi); c.hline(66, 94, 88, C.ripple);
    frog(c, 70, 66, { cols: 20, rows: 16 });
    for (const [x, y] of [[20, 44], [104, 34], [150, 50], [56, 36]]) firefly(c, x, y);
    return c;
  },
};

const only = process.argv[2];
for (const [name, draw] of Object.entries(COVERS)) {
  if (only && only !== name) continue;
  savePng(draw(), join(OUT, `${name}.png`));
  console.log(`wrote site/assets/releases/${name}.png`);
}
