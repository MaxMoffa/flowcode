// The empty chat's two frog scenes - "Stagno": the frog surfacing from a pond
// while the agent starts, and the burst of ripples when a conversation is
// cleared. Pure math over time; ChatEmptyFrog draws it.
import { FROG_PIXELS, REST_POSE } from "../terminal/frogArt";

/** A ripple: its center in frog pixels (from the frog's top left), its radius in
 * frog pixels (the vertical radius is squashed to RING_SQUASH), and its opacity. */
export interface Ring {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export interface SceneFrame {
  lift: number;
  lid: number;
  vivid: number;
  cursor: boolean;
  /** Whether the frog is out at all yet. */
  show: boolean;
  /** Where the water line is, as a fraction (0-1) of the frog's height from its
   * top: nothing is drawn below it. Null: no water. */
  waterline: number | null;
  rings: Ring[];
  /** The scene is over: the frog rests as it does when idle. */
  done: boolean;
}

export const RING_SQUASH = 0.55;
/** How long the clear scene lasts. */
export const CLEAR_MS = 3000;
/** How long the load scene goes on after the agent is ready. */
export const RISE_TAIL_MS = 1700;

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (t: number) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const seq = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lidBlink = (t: number, a: number, b: number) => {
  const u = (t - a) / (b - a);
  return u <= 0 || u >= 1 ? 0 : Math.sin(u * Math.PI);
};
/** The lit `_` blinks like the page frog's, every half second. */
const cursorAt = (t: number) => Math.floor(t / 500) % 2 === 0;

/** The scene was drawn with 5 px frog pixels; the chat's are 4. */
const SCALE = 5 / 4;
const CX = FROG_PIXELS.width / 2;
/** The pond's surface sits fixed on screen at this fraction of the frog's height while it floats
 * (its eyes just out); as it rises the water drops to the frog's bottom. */
const WATER = 0.55;
/** How far down (units) the frog floats: its eyes' middle is at the surface. */
const SINK = 170;
const waterOf = (lift: number) => (lift > 0 ? WATER + (1 - WATER) * (1 - Math.min(1, lift / SINK)) : null);
/** Lift (units, positive down) of a rise from `from` to the surface, with a small overshoot. */
const rise = (from: number, t: number) => {
  const r = ease(t);
  return lerp(from, 0, r) + Math.sin(r * Math.PI) * -40 * (r < 1 ? 1 : 0);
};

/** After "/clear": ripples from the frog, which comes up from below and blinks twice. */
export function clearFrame(t: number): SceneFrame {
  const rings: Ring[] = [];
  for (const d of [200, 520, 840]) {
    const u = seq(t, d, d + 1300);
    if (u > 0 && u < 1) rings.push({ x: CX, y: FROG_PIXELS.height * 0.75, r: lerp(2, 24, ease(u)) * SCALE, alpha: (1 - u) * 0.8 });
  }
  const lift = rise(SINK, seq(t, 350, 1000));
  return {
    lift,
    lid: Math.max(lidBlink(t, 1100, 1350), lidBlink(t, 1500, 1750)),
    vivid: 1 - ease(seq(t, 2100, 2500)),
    cursor: cursorAt(t),
    show: t >= 350,
    waterline: waterOf(lift),
    rings,
    done: t >= CLEAR_MS,
  };
}

/** While the agent starts: the frog floats with only its eyes out, blinking, ripples
 * spreading. `readyAt` is when the agent became ready (null: not yet, keep looping):
 * then it climbs out, blinks once and settles. */
export function loadFrame(t: number, readyAt: number | null): SceneFrame {
  const ready = readyAt ?? Infinity;
  const bob = (at: number) => SINK + Math.sin(at / 380) * 12;
  const rings: Ring[] = [];
  const last = Math.floor(Math.min(t, ready + 200) / 900);
  for (let k = Math.max(0, last - 1); k <= last; k++) {
    const d = k * 900;
    const u = seq(t - d, 0, 1300);
    if (t >= d && u < 1 && t < ready + 200) rings.push({ x: CX, y: FROG_PIXELS.height * 0.45, r: lerp(2, 16, ease(u)) * SCALE, alpha: (1 - u) * 0.55 });
  }
  const lift = t < ready ? bob(t) : rise(bob(ready), seq(t, ready, ready + 700));
  const lid = t < ready ? lidBlink(t % 1700, 1400, 1600) : lidBlink(t, ready + 800, ready + 1050);
  return {
    lift,
    lid,
    vivid: t >= ready + 1300 ? 1 - ease(seq(t, ready + 1300, ready + 1600)) : 1,
    cursor: cursorAt(t),
    show: true,
    waterline: waterOf(lift),
    rings,
    done: t >= ready + RISE_TAIL_MS,
  };
}

/** The pose the frog is drawn in for a frame. */
export const poseOf = (f: SceneFrame) => ({ ...REST_POSE, lift: f.lift, lid: f.lid, vivid: f.vivid, cursor: f.cursor });
