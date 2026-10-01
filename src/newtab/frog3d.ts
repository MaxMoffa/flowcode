/** The banner frog as a little 3D scene, for the catch: an ellipsoid body,
 * sphere eye bumps with eyeballs, pupils and glints on them, the `>_`
 * painted on the belly, and a tongue. Seen straight on and at rest it
 * projects onto exactly the flat drawing in asciiBanner.ts - the same
 * circles and ellipse - so the catch starts and ends without a jump.
 *
 * Everything is in the frog's drawing units (asciiBanner's FROG_BOX): x to
 * the right, y down, z toward the viewer. The view is orthographic. */

export type Vec3 = [number, number, number];

export interface FrogScene {
  /** Turn (radians): negative brings the frog's front round to the left. */
  yaw: number;
  /** Nod: positive tips the head back, as if looking up. */
  pitch: number;
  /** Lean to the side, about the frog's own front-back axis. */
  roll: number;
  /** Squash and stretch of the body, about its bottom center. */
  scale: Vec3;
  /** Whole-body shift on screen (units; `lift` up is negative). */
  shiftX: number;
  lift: number;
  /** Pupils' offset, as in FrogPose. */
  lookX: number;
  lookY: number;
  cursor: boolean;
  /** The tongue: out of the mouth toward a point on screen, `out` (0-1) of
   * the way there. */
  tongue: { target: [number, number]; out: number } | null;
  /** How far it has slipped from ASCII art into a real frog (0-1): wet,
   * spotted skin, golden eyes with slit pupils, a mouth for a `>_`. */
  real: number;
}

export const REST_SCENE: FrogScene = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  scale: [1, 1, 1],
  shiftX: 0,
  lift: 0,
  lookX: 0,
  lookY: 6,
  cursor: true,
  tongue: null,
  real: 0,
};

/** The body turns, nods and squashes about its bottom center. */
const ORIGIN: Vec3 = [512, 830, 0];
const BODY = { c: [512, 610, 0] as Vec3, r: [360, 220, 260] as Vec3 };
const EYE_Z = 40;
const EYES = [340, 684];
export const MOUTH: Vec3 = [512, 700, 200];
const TONGUE_RADIUS = 22;

/** A material: its color at rest (the flat drawing's), the tint its shadow
 * side falls toward - a deeper, cooler shade of itself rather than black -
 * the tint its rim catches, and how glossy it is (0: matte). */
interface Material {
  base: Rgb;
  shadow: Rgb;
  rim: Rgb;
  gloss: number;
}

type Rgb = [number, number, number];

const rgb = (hex: string): Rgb => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4), 16)];

const GREEN: Material = { base: rgb("A3E635"), shadow: rgb("3F8F3A"), rim: rgb("ECFCCB"), gloss: 0.25 };
const WHITE: Material = { base: rgb("FFFFFF"), shadow: rgb("B8C4D6"), rim: rgb("FFFFFF"), gloss: 0.9 };
const PINK: Material = { base: rgb("F472B6"), shadow: rgb("B4237A"), rim: rgb("FCE7F3"), gloss: 0.6 };
const DARK = "14532D";

/** Light from the upper left, a little in front. */
const LIGHT: Vec3 = (() => {
  const v: Vec3 = [-0.45, -0.6, 0.66];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
})();

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const rotY = ([x, y, z]: Vec3, a: number): Vec3 => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotX = ([x, y, z]: Vec3, a: number): Vec3 => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotZ = ([x, y, z]: Vec3, a: number): Vec3 => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];

/** The body's own turn, nod and lean applied to a direction (no scale). */
function rotate(v: Vec3, s: FrogScene): Vec3 {
  return rotY(rotX(rotZ(v, s.roll), s.pitch), s.yaw);
}

function unrotate(v: Vec3, s: FrogScene): Vec3 {
  return rotZ(rotX(rotY(v, -s.yaw), -s.pitch), -s.roll);
}

/** A point of the frog (rest frame) to where it is on screen, z included. */
export function toWorld(p: Vec3, s: FrogScene): Vec3 {
  const q = sub(p, ORIGIN);
  const scaled: Vec3 = [q[0] * s.scale[0], q[1] * s.scale[1], q[2] * s.scale[2]];
  return add(add(rotate(scaled, s), ORIGIN), [s.shiftX, s.lift, 0]);
}

/** A screen-space point back into the frog's rest frame. */
function toFrog(w: Vec3, s: FrogScene): Vec3 {
  const q = unrotate(sub(w, add(ORIGIN, [s.shiftX, s.lift, 0])), s);
  return add([q[0] / s.scale[0], q[1] / s.scale[1], q[2] / s.scale[2]], ORIGIN);
}

/** A screen-space direction into the frog's rest frame. */
function dirToFrog(v: Vec3, s: FrogScene): Vec3 {
  const q = unrotate(v, s);
  return [q[0] / s.scale[0], q[1] / s.scale[1], q[2] / s.scale[2]];
}

/** Nearest-to-viewer hit of the ray `o + t*d` with an axis-aligned
 * ellipsoid, as `t`, or null. */
function hitEllipsoid(o: Vec3, d: Vec3, c: Vec3, r: Vec3): number | null {
  const oc: Vec3 = [(o[0] - c[0]) / r[0], (o[1] - c[1]) / r[1], (o[2] - c[2]) / r[2]];
  const dd: Vec3 = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dd, dd);
  const b = dot(oc, dd);
  const disc = b * b - a * (dot(oc, oc) - 1);
  if (disc < 0) return null;
  return (-b + Math.sqrt(disc)) / a;
}

const hitSphere = (o: Vec3, d: Vec3, c: Vec3, r: number) => hitEllipsoid(o, d, c, [r, r, r]);

/** Distance from point (x, y) to the segment a-b, in the plane. */
function segment2d(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const sx = bx - ax;
  const sy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)));
  return Math.hypot(x - (ax + t * sx), y - (ay + t * sy));
}

/** Nearest-to-viewer hit of the ray with a capsule (segment a-b, radius r):
 * where the ray passes closest to the segment, when within r. */
function hitCapsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number): number | null {
  const u = sub(b, a);
  const w = sub(o, a);
  const uu = dot(u, u);
  const ud = dot(u, d);
  const dd = dot(d, d);
  const den = uu * dd - ud * ud;
  let s = den > 1e-9 ? (uu === 0 ? 0 : (dot(u, w) * dd - ud * dot(d, w)) / den) : 0;
  s = Math.max(0, Math.min(1, s));
  const p = add(a, mul(u, s));
  const t = dot(sub(p, o), d) / dd;
  const gap = Math.hypot(...sub(add(o, mul(d, t)), p));
  if (gap > r) return null;
  return t + Math.sqrt(r * r - gap * gap) / Math.sqrt(dd);
}

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const toHex = (c: Rgb) => c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Soft, modern shading - a smooth wrap-around falloff into a colored
 * shadow, a rim of light along the silhouette and a small crisp highlight -
 * faded in by `shade` (0-1), so a frog at rest stays its flat colors. */
function tone(m: Material, normal: Vec3, light: Vec3, view: Vec3, shade: number): Rgb {
  if (shade <= 0) return m.base;
  const len = Math.hypot(...normal) || 1;
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];
  // Wrap lighting: the light reaches past the terminator, so the dark side
  // rolls off gently instead of dropping to a hard edge.
  const diffuse = Math.max(0, (dot(n, light) + 0.6) / 1.6);
  let c = mix(m.base, m.shadow, shade * (1 - diffuse) ** 1.4 * 0.85);
  // A rim of light where the surface turns away from the viewer.
  const rim = (1 - Math.max(0, dot(n, view))) ** 3;
  c = mix(c, m.rim, shade * rim * 0.55);
  // A small, crisp highlight.
  const half: Vec3 = [light[0] + view[0], light[1] + view[1], light[2] + view[2]];
  const hl = Math.hypot(...half) || 1;
  const spec = Math.max(0, dot(n, [half[0] / hl, half[1] / hl, half[2] / hl])) ** 40;
  c = mix(c, [255, 255, 255], shade * m.gloss * spec);
  return c;
}

/** Smooth 3D value noise in 0-1, for the real frog's skin. */
function noise(x: number, y: number, z: number): number {
  const hash = (i: number, j: number, k: number) => {
    const h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const [ix, iy, iz] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [fx, fy, fz] = [x - ix, y - iy, z - iz].map((f) => f * f * (3 - 2 * f));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const layer = (k: number) =>
    lerp(lerp(hash(ix, iy, k), hash(ix + 1, iy, k), fx), lerp(hash(ix, iy + 1, k), hash(ix + 1, iy + 1, k), fx), fy);
  return lerp(layer(iz), layer(iz + 1), fz);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Real-frog lighting: diffuse with a soft ambient, a wet, sharp highlight
 * and a broad sheen. */
function lit(albedo: Rgb, n: Vec3, light: Vec3, view: Vec3, wet: number): Rgb {
  const len = Math.hypot(...n) || 1;
  const u: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  const diffuse = 0.32 + 0.68 * Math.max(0, (dot(u, light) + 0.25) / 1.25);
  let c: Rgb = [albedo[0] * diffuse, albedo[1] * diffuse, albedo[2] * diffuse];
  const half: Vec3 = [light[0] + view[0], light[1] + view[1], light[2] + view[2]];
  const hl = Math.hypot(...half) || 1;
  const h = Math.max(0, dot(u, [half[0] / hl, half[1] / hl, half[2] / hl]));
  c = mix(c, [255, 255, 250], wet * (h ** 70 * 0.9 + h ** 8 * 0.12));
  // Light bouncing off the ground, from below.
  return mix(c, [190, 220, 120], Math.max(0, u[1]) * 0.12);
}

const SKIN = rgb("7FB82E");
const SPOTS = rgb("3E5F14");
const BELLY = rgb("E4F2B0");
const IRIS = rgb("D7A21E");
const IRIS_DARK = rgb("7A5410");
const TONGUE = rgb("E0607E");

/** Where the tongue's tip is, in the frog's rest frame: aimed at its screen
 * target at the mouth's depth, so it lands on it whatever the body does. */
export function tongueTip(s: FrogScene): Vec3 | null {
  if (!s.tongue) return null;
  const mouth = toWorld(MOUTH, s);
  const target = toFrog([s.tongue.target[0], s.tongue.target[1], mouth[2]], s);
  return add(MOUTH, mul(sub(target, MOUTH), s.tongue.out));
}

/** The screen box (units) the frog and its tongue can cover. */
export function sceneBounds(s: FrogScene): { left: number; right: number; top: number; bottom: number } {
  let [left, right, top, bottom] = [130, 894, 205, 855];
  // Turned, nodded or lifted, it can stick out of its own box a little.
  [left, right, top, bottom] = [left + s.shiftX - 80, right + s.shiftX + 80, top + s.lift - 80, bottom + 40];
  if (s.tongue) {
    const tip = tongueTip(s)!;
    const [x, y] = toWorld(tip, s);
    left = Math.min(left, x - 60);
    right = Math.max(right, x + 60);
    top = Math.min(top, y - 60);
    bottom = Math.max(bottom, y + 60);
  }
  return { left, right, top, bottom };
}

/** The color of the scene at screen point (x, y), or null for nothing. */
export function sceneColor(x: number, y: number, s: FrogScene): string | null {
  const c = sceneRgb(x, y, s);
  return c ? toHex(c) : null;
}

/** What a ray hit: which part, where, and the surface's normal there (all
 * in the frog's rest frame). */
type Part = "body" | "bump" | "ball" | "pupil" | "glint" | "tongue";

/** The scene's color at screen point (x, y) as RGB, or null for nothing -
 * the ASCII frog's look, the real frog's, or a blend while it slips. */
/** What every ray of a frame shares - worked out once per scene. The map
 * from screen to the frog's frame is affine, so a ray's origin is the
 * screen origin's image plus x and y steps. */
interface Prepared {
  origin: Vec3;
  stepX: Vec3;
  stepY: Vec3;
  d: Vec3;
  light: Vec3;
  view: Vec3;
  shade: number;
  tip: Vec3 | null;
}

const prepared = new WeakMap<FrogScene, Prepared>();

function prepare(s: FrogScene): Prepared {
  let p = prepared.get(s);
  if (!p) {
    const origin = toFrog([0, 0, 0], s);
    const d = dirToFrog([0, 0, 1], s);
    const dl = Math.hypot(...d) || 1;
    p = {
      origin,
      stepX: dirToFrog([1, 0, 0], s),
      stepY: dirToFrog([0, 1, 0], s),
      d,
      light: unrotate(LIGHT, s),
      view: [d[0] / dl, d[1] / dl, d[2] / dl],
      shade: Math.min(1, Math.abs(Math.sin(s.yaw)) * 1.4 + Math.abs(Math.sin(s.pitch)) * 1.6 + Math.abs(Math.sin(s.roll))),
      tip: tongueTip(s),
    };
    prepared.set(s, p);
  }
  return p;
}

export function sceneRgb(x: number, y: number, s: FrogScene): Rgb | null {
  const f = prepare(s);
  const o: Vec3 = [
    f.origin[0] + f.stepX[0] * x + f.stepY[0] * y,
    f.origin[1] + f.stepX[1] * x + f.stepY[1] * y,
    f.origin[2] + f.stepX[2] * x + f.stepY[2] * y,
  ];
  const { d, light, view, shade } = f;
  const realEyes = s.real >= 0.5;

  let best = -Infinity;
  let hit: { part: Part; p: Vec3; n: Vec3; eye: number } | null = null;
  const consider = (t: number | null, part: Part, normal: (p: Vec3) => Vec3, eye = 0) => {
    if (t === null || t <= best) return;
    best = t;
    const p = add(o, mul(d, t));
    hit = { part, p, n: normal(p), eye };
  };

  // Rays that pass well clear of the frog's body and eyes can only meet the
  // tongue: skip the rest for them.
  const toCenter = sub([512, 560, 0], o);
  const nearFrog = Math.hypot(...sub(toCenter, mul(d, dot(toCenter, d) / dot(d, d)))) < 560;
  if (nearFrog) {
    consider(hitEllipsoid(o, d, BODY.c, BODY.r), "body", (p) => [
      (p[0] - BODY.c[0]) / BODY.r[0] ** 2,
      (p[1] - BODY.c[1]) / BODY.r[1] ** 2,
      (p[2] - BODY.c[2]) / BODY.r[2] ** 2,
    ]);
    EYES.forEach((cx, i) => {
      const bump: Vec3 = [cx, 400, EYE_Z];
      consider(hitSphere(o, d, bump, 135), "bump", (p) => sub(p, bump), i);
      const ball: Vec3 = [cx, 393, EYE_Z + 140];
      consider(hitSphere(o, d, ball, 85), "ball", (p) => sub(p, ball), i);
      if (!realEyes) {
        const pupil: Vec3 = [cx + s.lookX, 393 + s.lookY, EYE_Z + 215];
        consider(hitSphere(o, d, pupil, 45), "pupil", (p) => sub(p, pupil), i);
        const glint: Vec3 = [pupil[0] + 14, pupil[1] - 15, pupil[2] + 40];
        consider(hitSphere(o, d, glint, 16), "glint", (p) => sub(p, glint), i);
      }
    });
  }
  const tip = f.tip;
  if (tip && Math.hypot(...sub(tip, MOUTH)) > 30) {
    const along = sub(tip, MOUTH);
    consider(hitCapsule(o, d, MOUTH, tip, TONGUE_RADIUS), "tongue", (p) => {
      const n = sub(p, MOUTH);
      return sub(n, mul(along, dot(n, along) / (dot(along, along) || 1)));
    });
    // A sticky round tip.
    consider(hitSphere(o, d, tip, 34), "tongue", (p) => sub(p, tip));
  }
  if (!hit) return null;
  const { part, p, n, eye } = hit as { part: Part; p: Vec3; n: Vec3; eye: number };

  const styled = (): Rgb => {
    if (part === "pupil") return rgb(DARK);
    if (part === "glint") return [255, 255, 255];
    if (part === "tongue") return tone(PINK, n, light, view, Math.max(shade, 0.6));
    if (part === "ball") return tone(WHITE, n, light, view, shade);
    // The `>_` is painted on the front of the belly.
    if (part === "body" && p[2] > 0) {
      const strokes: [number, number, number, number][] = [
        [396, 575, 472, 632],
        [472, 632, 396, 689],
      ];
      if (s.cursor) strokes.push([526, 689, 636, 689]);
      if (strokes.some((k) => segment2d(p[0], p[1], ...k) <= 24)) return rgb(DARK);
    }
    return tone(GREEN, n, light, view, shade);
  };

  const real = (): Rgb => {
    if (part === "tongue") return lit(TONGUE, n, light, view, 0.9);
    if (part === "ball") {
      // A golden iris round the way the eye looks, a dark horizontal slit.
      const cx = EYES[eye];
      const look: Vec3 = [s.lookX * 1.4, s.lookY * 1.4, 85];
      const ll = Math.hypot(...look);
      const q: Vec3 = [(p[0] - cx) / 85, (p[1] - 393) / 85, (p[2] - EYE_Z - 140) / 85];
      const facing = dot(q, [look[0] / ll, look[1] / ll, look[2] / ll]);
      let albedo: Rgb = [236, 238, 226];
      if (facing > 0.5) {
        const u = q[0] - (look[0] / ll) * facing;
        const v = q[1] - (look[1] / ll) * facing;
        const ring = (1 - facing) / 0.5;
        albedo = mix(IRIS, IRIS_DARK, 0.25 + 0.5 * ring + 0.25 * noise(u * 18, v * 18, eye * 5));
        if ((u / 0.42) ** 2 + (v / 0.13) ** 2 < 1) albedo = [12, 12, 10];
      }
      return lit(albedo, n, light, view, 1);
    }
    // Skin: spots, a darker back, a pale belly, and a mouth line.
    const spots = smooth(0.6, 0.72, noise(p[0] / 70, p[1] / 70, p[2] / 70 + eye * 3));
    let albedo = mix(SKIN, SPOTS, spots * 0.85);
    albedo = mix(albedo, SPOTS, smooth(520, 300, p[1]) * 0.25);
    if (part === "body") {
      albedo = mix(albedo, BELLY, smooth(640, 760, p[1]) * smooth(60, 200, p[2]));
      const lip = 690 - ((p[0] - 512) / 240) ** 2 * 50;
      if (p[2] > 60 && Math.abs(p[0] - 512) < 250 && Math.abs(p[1] - lip) < 7) albedo = [40, 52, 16];
    }
    return lit(albedo, n, light, view, 0.75);
  };

  if (s.real <= 0) return styled();
  if (s.real >= 1) return real();
  return mix(styled(), real(), s.real);
}
