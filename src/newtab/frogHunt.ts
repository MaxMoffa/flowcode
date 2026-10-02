import { MOUTH, REST_SCENE, toWorld, tongueTip, type FrogScene, type Vec3 } from "./frog3d";

/** The frog's catch, on a click: a fly flutters about the page and lands on
 * something - a letter of the wordmark, the tagline, the system table, the
 * prompt, a list row, a shell button. The frog follows it with its eyes and
 * head, crouches, turns toward it (left or right), shoots out its tongue
 * with a lunge and reels it in - sometimes missing first, when the fly takes
 * off just in time and lands again nearby - then turns back and reacts.
 * Each catch is planned afresh: path, landing spot, timings, how far and how
 * springily the frog turns, whether it hops into the turn, how hard it
 * lunges. Everything is in the frog's drawing units (FROG_BOX). */

export interface Point {
  x: number;
  y: number;
}

/** Where the fly can go: groups of spots to land on (one group per kind of
 * thing - picked evenly, so the many cells of the wordmark don't crowd out
 * the rest), and the stretch of page to flutter about in. */
export interface FlyArea {
  spots: Point[][];
  bounds: { left: number; right: number; top: number; bottom: number };
}

/** A frame of the catch, for the page to draw over itself. */
export interface CatchFrame {
  scene: FrogScene;
  /** `flap`: wings up this frame (they beat while it flies, rest level).
   * `word`: when the prey is a word typed on the prompt, the word itself,
   * carried off on the tongue. */
  fly: (Point & { flap: boolean; word?: string }) | null;
  /** The rare catch where the frog slips out of the drawing into a real frog:
   * how far (0-1, the scene's `real`) and how hard it glitches doing it. */
  real: { amount: number; glitch: number } | null;
  /** How awake the frog is (0-1), for its colors - see FrogPose. */
  vivid?: number;
}

export type Reaction = "puff" | "hop" | "blink" | "none";

interface Shot {
  at: number;
  reachMs: number;
  holdMs: number;
  reelMs: number;
  target: Point;
  catches: boolean;
}

/** How this frog moves this time. */
interface Style {
  /** How much its head follows the flying fly (radians at most). */
  follow: number;
  crouch: number;
  crouchMs: number;
  /** Lean into the turn, radians. */
  bank: number;
  hop: number;
  overshoot: boolean;
  lunge: number;
  /** Nod as the tongue comes back, radians. */
  bob: number;
  /** Idle sway while it waits, radians. */
  sway: number;
}

export interface HuntPlan {
  /** A word typed on the prompt as the prey, instead of a fly: no flight,
   * nothing to draw until the tongue has it. */
  prey: { word: string } | null;
  flight: { path: Point[]; ms: number };
  /** The fly's escape from a missed shot, to a second spot. */
  escape: { at: number; ms: number; path: Point[] } | null;
  turn: { at: number; ms: number; yaw: number; pitch: number };
  shots: Shot[];
  turnBack: { at: number; ms: number };
  /** The rare real-frog catch: it slips into a real frog mid-turn, and once
   * it has eaten, faces front, shakes itself and slips back into the drawing. */
  real: { evolveAt: number; evolveMs: number; shakeAt: number; shakeMs: number; devolveAt: number; devolveMs: number } | null;
  total: number;
  style: Style;
  after: Reaction;
}

const between = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const ease = (t: number) => t * t * (3 - 2 * t);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
/** Past the end and back - a turn that swings a little too far. */
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const deg = (d: number) => (d * Math.PI) / 180;

/** Catmull-Rom through `points`, at `t` (0-1) spread evenly over them. */
function along(points: Point[], t: number): Point {
  const n = points.length - 1;
  const f = clamp01(t) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const [p0, p1, p2, p3] = [points[Math.max(0, i - 1)], points[i], points[i + 1], points[Math.min(n, i + 2)]];
  const c = (a: number, b: number, c2: number, d: number) =>
    0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
  return { x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y) };
}

/** The frog's middle and its mouth at rest, on screen. */
const CENTER_X = 512;
const MOUTH_Y = MOUTH[1];

/** How far and which way to turn for a fly at `p`: toward its side, more
 * the further off to that side it is; and a nod up or down toward it. */
function turnFor(p: Point): { yaw: number; pitch: number } {
  const dx = p.x - CENTER_X;
  const dy = p.y - MOUTH_Y;
  const side = Math.abs(dx) / (Math.hypot(dx, dy) || 1);
  const yaw = Math.sign(dx || -1) * deg(between(30, 42) + side * between(36, 46));
  const pitch = Math.max(-0.45, Math.min(0.45, Math.atan2(-dy, Math.abs(dx) + 300) * between(0.5, 0.8)));
  return { yaw, pitch };
}

/** When the tongue gets the prey: the moment a catching shot reaches it. */
export function catchTime(plan: HuntPlan): number {
  const shot = plan.shots.find((s) => s.catches)!;
  return shot.at + shot.reachMs;
}

/** Plans a catch: of a fly flying in to land somewhere in `area`, or - with
 * `prey` - of a word sitting on the prompt at `prey.spot`, which the frog
 * goes for straight away and never misses. */
export function planHunt(area: FlyArea, prey?: { word: string; spot: Point }): HuntPlan | null {
  const groups = prey ? [[prey.spot]] : area.spots.filter((g) => g.length > 0);
  if (groups.length === 0) return null;
  const group = pick(groups);
  const land = pick(group);
  const { left, right, top, bottom } = area.bounds;
  const inside = (): Point => ({ x: between(left, right), y: between(top, bottom) });
  // In from somewhere along an edge, a few turns about the page, then down
  // onto its spot.
  const start = pick<Point>([
    { x: between(left, right), y: top },
    { x: left, y: between(top, bottom) },
    { x: right, y: between(top, bottom) },
  ]);
  const turns = Array.from({ length: Math.floor(between(2, 5)) }, inside);
  const approach = { x: land.x + between(-140, 140), y: land.y - between(40, 160) };
  const flight = prey ? { path: [land, land], ms: 1 } : { path: [start, ...turns, approach, land], ms: between(1400, 2800) };

  const style: Style = {
    follow: deg(between(8, 26)),
    crouch: between(0.04, 0.13),
    crouchMs: between(110, 240),
    bank: deg(between(3, 13)),
    hop: Math.random() < 0.35 ? between(30, 70) : 0,
    overshoot: Math.random() < 0.5,
    lunge: between(15, 60),
    bob: deg(between(3, 10)),
    sway: deg(between(0.8, 3)),
  };
  const { yaw, pitch } = turnFor(land);
  // A word on the prompt: it spots it at once - a beat of a stare first.
  const turn = { at: prey ? between(250, 600) : flight.ms + between(180, 700), ms: between(380, 780), yaw, pitch };
  const shotTimes = () => ({ reachMs: between(220, 430), holdMs: between(50, 180), reelMs: between(240, 500) });

  const shots: Shot[] = [];
  let escape: HuntPlan["escape"] = null;
  let clock = turn.at + turn.ms + between(40, 280);
  const nearby = group.filter((s) => Math.hypot(s.x - land.x, s.y - land.y) > 60);
  if (!prey && Math.random() < 0.3 && nearby.length > 0) {
    // A miss: the fly is off just before the tongue gets there, and settles
    // again further along the same thing.
    const miss: Shot = { at: clock, ...shotTimes(), target: land, catches: false };
    shots.push(miss);
    const second = pick(nearby);
    const lift = { x: (land.x + second.x) / 2 + between(-90, 90), y: Math.min(land.y, second.y) - between(90, 220) };
    escape = { at: clock + miss.reachMs * 0.55, ms: between(380, 640), path: [land, lift, second] };
    clock = Math.max(clock + miss.reachMs + miss.holdMs + miss.reelMs + between(120, 320), escape.at + escape.ms + between(80, 260));
    shots.push({ at: clock, ...shotTimes(), target: second, catches: true });
  } else {
    shots.push({ at: clock, ...shotTimes(), target: land, catches: true });
  }
  const last = shots[shots.length - 1];
  const turnBack = { at: last.at + last.reachMs + last.holdMs + last.reelMs + between(60, 260), ms: between(450, 850) };
  if (Math.random() < 0.2) {
    // Real for a moment: it slips mid-turn, then - fed - snaps round to face
    // front, shakes the realness off and drops back into the drawing mid-shake.
    turnBack.ms = between(260, 380);
    const shakeAt = turnBack.at + turnBack.ms;
    const shakeMs = between(900, 1300);
    const devolveAt = shakeAt + shakeMs * between(0.4, 0.6);
    const devolveMs = between(500, 750);
    const real = { evolveAt: turn.at + turn.ms * between(0.15, 0.45), evolveMs: between(550, 800), shakeAt, shakeMs, devolveAt, devolveMs };
    return {
      prey: prey ? { word: prey.word } : null,
      flight,
      escape,
      turn,
      shots,
      turnBack,
      real,
      total: Math.max(shakeAt + shakeMs, devolveAt + devolveMs),
      style,
      after: "none",
    };
  }
  return {
    prey: prey ? { word: prey.word } : null,
    flight,
    escape,
    turn,
    shots,
    turnBack,
    real: null,
    total: turnBack.at + turnBack.ms,
    style,
    after: pick<Reaction>(["puff", "puff", "hop", "blink", "none"]),
  };
}

/** How far out (0-1) a shot's tongue is at `t`. */
function tongueOut(shot: Shot, t: number): number {
  const s = t - shot.at;
  if (s <= 0) return 0;
  if (s < shot.reachMs) return easeOutCubic(s / shot.reachMs);
  if (s < shot.reachMs + shot.holdMs) return 1;
  return 1 - ease(clamp01((s - shot.reachMs - shot.holdMs) / shot.reelMs));
}

/** Where the fly is at `t`, ignoring a catch: flying its path, escaping, or
 * sitting on its spot. */
function flyAt(plan: HuntPlan, t: number, jitter: boolean): Point & { flap: boolean } {
  const flap = Math.floor(t / 40) % 2 === 0;
  if (t < plan.flight.ms) {
    const p = t / plan.flight.ms;
    const at = along(plan.flight.path, ease(p));
    // A jittery flutter, settling as it comes in to land.
    const j = jitter ? (1 - p) * 18 : 0;
    return { x: at.x + Math.sin(t / 31) * j, y: at.y + Math.cos(t / 23) * j, flap };
  }
  if (plan.escape && t >= plan.escape.at) {
    const p = (t - plan.escape.at) / plan.escape.ms;
    return { ...along(plan.escape.path, ease(clamp01(p))), flap: p < 1 && flap };
  }
  return { ...plan.flight.path[plan.flight.path.length - 1], flap: false };
}

export function huntFrame(plan: HuntPlan, t: number): CatchFrame {
  const { turn, turnBack, style } = plan;
  const side = Math.sign(turn.yaw);
  const scene: FrogScene = { ...REST_SCENE, scale: [1, 1, 1], lookX: 0, lookY: 0 };

  // Before turning, the head follows the fly a little as it flies about.
  const follow = (p: Point) => Math.max(-1, Math.min(1, (p.x - CENTER_X) / 700)) * style.follow;
  const followAtTurn = follow(flyAt(plan, turn.at, false));

  if (t < turn.at) {
    const fly = flyAt(plan, t, false);
    // Eased in, so the frog starts from exactly where it stood.
    const settle = ease(clamp01(t / 500));
    scene.yaw = follow(fly) * (t > turn.at - 500 ? 1 : settle);
    scene.roll = Math.sin(t / 420) * style.sway * settle;
    // A crouch, winding up for the turn.
    const c = clamp01((t - (turn.at - style.crouchMs)) / style.crouchMs);
    const k = Math.sin(Math.PI * c * 0.5) * style.crouch;
    scene.scale = [1 + k * 0.6, 1 - k, 1 + k * 0.6];
  } else if (t < turnBack.at) {
    const p = clamp01((t - turn.at) / turn.ms);
    const curve = style.overshoot ? easeOutBack(p) : ease(p);
    scene.yaw = lerp(followAtTurn, turn.yaw, curve);
    scene.pitch = turn.pitch * ease(p);
    // Leaning into the turn, hopping round when it's that kind of frog,
    // springing up out of the crouch.
    scene.roll = -side * style.bank * Math.sin(Math.PI * p) + (p >= 1 ? Math.sin((t - turn.at) / 380) * style.sway : 0);
    scene.lift = -style.hop * Math.sin(Math.PI * p);
    const k = style.crouch * (1 - ease(Math.min(1, p * 2)));
    scene.scale = [1 + k * 0.6, 1 - k, 1 + k * 0.6];
  } else {
    const p = clamp01((t - turnBack.at) / turnBack.ms);
    scene.yaw = turn.yaw * (1 - ease(p));
    scene.pitch = turn.pitch * (1 - ease(p));
    // A little wobble settling back.
    scene.roll = side * style.bank * 0.6 * Math.sin(2 * Math.PI * p) * (1 - p);
    // Eyes back to rest, where the still frog has them.
    scene.lookY = Math.round(REST_SCENE.lookY * ease(p));
  }

  // The shot in play: the latest one that has started.
  const shot = [...plan.shots].reverse().find((s) => t >= s.at) ?? null;
  if (shot && t < turnBack.at) {
    const out = tongueOut(shot, t);
    if (out > 0) scene.tongue = { target: [shot.target.x, shot.target.y], out };
    // A lunge after the tongue, stretching; a nod as it comes back.
    scene.shiftX = Math.sign(shot.target.x - CENTER_X) * style.lunge * out;
    scene.scale = [scene.scale[0] * (1 - 0.03 * out), scene.scale[1] * (1 + 0.04 * out), scene.scale[2] * (1 + 0.06 * out)];
    const reel = clamp01((t - shot.at - shot.reachMs - shot.holdMs) / shot.reelMs);
    scene.pitch -= style.bob * Math.sin(Math.PI * reel);
  }

  // The fly: on the tongue once a catching shot reaches it, gone once it's
  // reeled in; otherwise wherever it is on its own.
  let fly: CatchFrame["fly"] = null;
  const caughtBy = plan.shots.find((s) => s.catches && t >= s.at + s.reachMs);
  if (caughtBy) {
    const tip = tongueTip(scene);
    if (tip && shot === caughtBy && (scene.tongue?.out ?? 0) > 0.1) {
      const [x, y] = toWorld(tip, scene);
      fly = { x, y, flap: false, ...(plan.prey ? { word: plan.prey.word } : {}) };
    }
  } else if (!plan.prey) {
    fly = flyAt(plan, t, true);
  }

  // Until it has turned, the frog watches the fly; turning, its eyes come
  // round to the front with it.
  const watched = fly ?? (plan.prey ? plan.flight.path[0] : null);
  if (watched && t < turn.at + turn.ms) {
    const eye: Vec3 = toWorld([CENTER_X, 393, 0], scene);
    const [dx, dy] = [watched.x - eye[0], watched.y - eye[1]];
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 900) * 30 * (1 - clamp01((t - turn.at) / turn.ms));
    scene.lookX = Math.round((dx / dist) * reach);
    scene.lookY = Math.round((dy / dist) * reach);
  }

  let real: CatchFrame["real"] = null;
  if (plan.real) {
    const r = plan.real;
    if (t >= r.shakeAt) {
      // Shaking itself off: jolts side to side, little hops, darting eyes,
      // all dying down.
      const p = clamp01((t - r.shakeAt) / r.shakeMs);
      const e = (1 - p) ** 1.5;
      const u = t - r.shakeAt;
      scene.roll = 0.24 * e * Math.sin(u / 38);
      scene.shiftX = 16 * e * Math.sin(u / 27);
      scene.lift = -Math.abs(Math.sin(u / 95)) * 40 * e;
      const k = 0.06 * e * Math.sin(u / 47);
      scene.scale = [1 + k, 1 - k, 1 + k];
      scene.lookX = Math.round(26 * e * Math.sin(u / 70));
      scene.lookY = Math.round(REST_SCENE.lookY + 10 * e * Math.cos(u / 53));
    }
    let amount = 0;
    let glitch = 0;
    if (t >= r.devolveAt) {
      const p = clamp01((t - r.devolveAt) / r.devolveMs);
      amount = 1 - ease(p);
      glitch = Math.sin(Math.PI * p);
    } else if (t >= r.evolveAt) {
      const p = clamp01((t - r.evolveAt) / r.evolveMs);
      amount = ease(p);
      glitch = Math.sin(Math.PI * p);
    }
    scene.real = amount;
    if (amount > 0 || glitch > 0) real = { amount, glitch };
  }
  return { scene, fly, real };
}
