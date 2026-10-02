import { useEffect, useRef, useState } from "react";
import { FROG_BOX, FROG_HEIGHT, FROG_WIDTH, REST_POSE, frogPixels, type FrogPose } from "../terminal/asciiBanner";
import { catchTime, huntFrame, planHunt, type CatchFrame, type FlyArea, type HuntPlan, type Point } from "./frogHunt";

export type { CatchFrame, FlyArea };

/** Pupil travel, in the frog's own units (sclera r=85, pupil r=45). */
const MAX_LOOK = 30;
/** After this long without the pointer moving, the frog looks back ahead. */
const POINTER_IDLE_MS = 4000;
/** How high a hop lifts it, in its own units - as much as the room above
 * its head in the banner allows. */
const HOP_LIFT = -60;
const BREATH_MS = 3400;
const CURSOR_BLINK_MS = 1100;
const BLINK_MS = 190;
/** How quickly it wakes up and dozes off: the time constant (ms) its life -
 * colors, breath, cursor - eases toward awake or asleep by. */
const LIFE_EASE_MS = 160;

/** The page's frog: the banner's cells, four times as many pixels - two
 * across and four down a cell, near enough square. */
export const FROG_PIXELS = { width: FROG_WIDTH * 2, height: FROG_HEIGHT * 4 };
const drawingOf = (pose: FrogPose) => frogPixels(pose, FROG_PIXELS.width, FROG_PIXELS.height).join();
const restDrawing = drawingOf(REST_POSE);

type Action = "hop" | "tilt" | "puff" | "look";

/** One keyframe of a body move: when (0-1) and the body's state then. */
type Key = [at: number, lift: number, scaleX: number, scaleY: number, rotate: number];

function moveKeys(kind: Exclude<Action, "look">): { keys: Key[]; duration: number } {
  if (kind === "hop") {
    return {
      duration: 620,
      keys: [
        [0, 0, 1, 1, 0],
        [0.18, 0, 1.08, 0.9, 0],
        [0.5, HOP_LIFT, 0.95, 1.06, 0],
        [0.82, 0, 1.06, 0.93, 0],
        [1, 0, 1, 1, 0],
      ],
    };
  }
  if (kind === "tilt") {
    const angle = Math.random() < 0.5 ? -8 : 8;
    return {
      duration: 1600,
      keys: [
        [0, 0, 1, 1, 0],
        [0.25, 0, 1, 1, angle],
        [0.75, 0, 1, 1, angle],
        [1, 0, 1, 1, 0],
      ],
    };
  }
  return {
    duration: 900,
    keys: [
      [0, 0, 1, 1, 0],
      [0.3, 0, 1.09, 0.94, 0],
      [0.5, 0, 1.02, 0.99, 0],
      [0.7, 0, 1.09, 0.94, 0],
      [1, 0, 1, 1, 0],
    ],
  };
}

const ease = (t: number) => t * t * (3 - 2 * t);

function sampleKeys(keys: Key[], t: number): Key {
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (t <= b[0]) {
      const f = ease((t - a[0]) / (b[0] - a[0] || 1));
      return a.map((v, j) => v + (b[j] - v) * f) as Key;
    }
  }
  return keys[keys.length - 1];
}

interface FrogPoseOptions {
  /** Animate at all - off while the page is hidden or handing over, when the
   * frog stands still in the pose the terminal prints. */
  active: boolean;
  /** Awake: it breathes, blinks, looks about and moves on its own. Asleep it
   * eases back to the pose the terminal prints, and stays there; a catch
   * wakes it for as long as it lasts. */
  awake: boolean;
  /** Where the frog is on screen right now (`null`: not drawn). */
  frogRect: () => DOMRect | null;
  /** Where the caret is while the user types, for the eyes to follow. */
  caret: () => { x: number; y: number } | null;
  /** Where the fly can go, in drawing units (null: no wordmark - no catch). */
  flyArea: () => FlyArea | null;
}

/** The page frog's pose over time. Awake, the pupils follow the pointer (or
 * the caret while typing), it breathes, blinks, and now and then hops,
 * tilts its head, puffs up or looks around; asleep, it eases back into the
 * pose the terminal prints - colors and all - and holds still. A new pose
 * is only handed out when it changes the drawing. */
/** Sends the frog after a word on the prompt; `onCatch` runs the moment the
 * tongue has it. False when it can't go now (busy with a catch, or still). */
export type HuntWord = (word: string, spot: Point, onCatch: () => void) => boolean;

export function useFrogPose({ active, awake, frogRect, caret, flyArea }: FrogPoseOptions): {
  pose: FrogPose;
  catching: CatchFrame | null;
  huntWord: HuntWord;
} {
  const [pose, setPose] = useState<FrogPose>(REST_POSE);
  const [catching, setCatching] = useState<CatchFrame | null>(null);
  const huntWordRef = useRef<HuntWord>(() => false);
  const optionsRef = useRef({ awake, frogRect, caret, flyArea });
  optionsRef.current = { awake, frogRect, caret, flyArea };

  useEffect(() => {
    if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPose(REST_POSE);
      setCatching(null);
      return;
    }
    const start = performance.now();
    const pointer = { x: 0, y: 0, last: -Infinity, over: false };
    const look = { x: REST_POSE.lookX, y: REST_POSE.lookY };
    let glance: { x: number; y: number; until: number } | null = null;
    let move: { keys: Key[]; duration: number; at: number } | null = null;
    let blink: { at: number; times: number } | null = null;
    let hunt: { at: number; plan: HuntPlan; onCatch?: () => void } | null = null;
    let drawn = restDrawing;
    /** 0 asleep - 1 awake, eased between the two. */
    let life = 0;
    let lastTick = start;
    let frame = 0;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    const act = (kind: Action) => {
      if (kind === "look") {
        const side = Math.random() < 0.5 ? -1 : 1;
        glance = { x: MAX_LOOK * side, y: -4, until: performance.now() + 700 };
        later(() => {
          glance = { x: -MAX_LOOK * side, y: -4, until: performance.now() + 700 };
        }, 700);
      } else if (!move) {
        move = { ...moveKeys(kind), at: performance.now() };
      }
    };

    /** The catch at `now`, or null once it's over - when the frog gets its
     * reaction in. */
    const catchFrame = (now: number): CatchFrame | null => {
      if (!hunt) return null;
      const t = now - hunt.at;
      if (hunt.onCatch && t >= catchTime(hunt.plan)) {
        hunt.onCatch();
        hunt.onCatch = undefined;
      }
      if (t < hunt.plan.total) return huntFrame(hunt.plan, t);
      const { after } = hunt.plan;
      hunt = null;
      if (after === "blink") blink = { at: now, times: 2 };
      else if (after !== "none") act(after);
      return null;
    };

    const startHunt = () => {
      if (hunt) return;
      const area = optionsRef.current.flyArea();
      const plan = area ? planHunt(area) : null;
      if (!plan) return;
      hunt = { at: performance.now(), plan };
      move = null;
      blink = null;
    };
    huntWordRef.current = (word, spot, onCatch) => {
      if (hunt) return false;
      const area = optionsRef.current.flyArea();
      const plan = area ? planHunt(area, { word, spot }) : null;
      if (!plan) return false;
      hunt = { at: performance.now(), plan, onCatch };
      move = null;
      blink = null;
      return true;
    };

    const tick = (now: number) => {
      const awakeNow = optionsRef.current.awake || hunt !== null;
      const goal = awakeNow ? 1 : 0;
      life += (goal - life) * (1 - Math.exp(-(now - lastTick) / LIFE_EASE_MS));
      if (Math.abs(goal - life) < 0.01) life = goal;
      lastTick = now;
      const frameOfCatch = catchFrame(now);
      if (frameOfCatch || hunt === null) setCatching(frameOfCatch && { ...frameOfCatch, vivid: life });
      // Asleep and settled: nothing to draw until something wakes it.
      const settled =
        !awakeNow && life === 0 && !move && !blink && Math.abs(look.x - REST_POSE.lookX) < 0.5 && Math.abs(look.y - REST_POSE.lookY) < 0.5;
      if (frameOfCatch || settled) {
        if (settled && drawn !== restDrawing) {
          drawn = restDrawing;
          setPose(REST_POSE);
        }
        frame = requestAnimationFrame(tick);
        return;
      }
      const rect = optionsRef.current.frogRect();
      // Eyes: a glance, else the caret while typing, else the pointer while
      // it moves, else straight ahead.
      let target = { x: REST_POSE.lookX, y: REST_POSE.lookY };
      if (rect && rect.width > 0 && awakeNow) {
        const unit = FROG_BOX.width / rect.width;
        const eyeY = rect.top + ((393 - FROG_BOX.y) / FROG_BOX.height) * rect.height;
        const eyeX = rect.left + ((512 - FROG_BOX.x) / FROG_BOX.width) * rect.width;
        const aim = (x: number, y: number) => {
          const [dx, dy] = [x - eyeX, y - eyeY];
          const dist = Math.hypot(dx, dy) || 1;
          const reach = Math.min(1, (dist * unit) / 900) * MAX_LOOK;
          return { x: (dx / dist) * reach, y: (dy / dist) * reach };
        };
        const typing = optionsRef.current.caret();
        if (glance && now < glance.until) target = glance;
        else if (typing && now - pointer.last > 600) target = aim(typing.x, typing.y);
        else if (now - pointer.last < POINTER_IDLE_MS) target = aim(pointer.x, pointer.y);
        const over = pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
        if (over && !pointer.over) act("hop");
        pointer.over = over;
      }
      look.x += (target.x - look.x) * 0.18;
      look.y += (target.y - look.y) * 0.18;

      const breath = (1 - Math.cos((2 * Math.PI * (now - start)) / BREATH_MS)) / 2;
      let [lift, scaleX, scaleY, rotate] = [0, 1 + 0.025 * breath * life, 1 - 0.025 * breath * life, 0];
      if (move) {
        const t = (now - move.at) / move.duration;
        if (t >= 1) move = null;
        else {
          const [, l, sx, sy, r] = sampleKeys(move.keys, t);
          [lift, scaleX, scaleY, rotate] = [l, scaleX * sx, scaleY * sy, r];
        }
      }
      let lid = 0;
      if (blink) {
        const t = (now - blink.at) / BLINK_MS;
        if (t >= blink.times) blink = null;
        else {
          const f = t % 1;
          lid = f < 0.45 ? f / 0.45 : f < 0.55 ? 1 : (1 - f) / 0.45;
        }
      }
      const next: FrogPose = {
        lookX: Math.round(look.x),
        lookY: Math.round(look.y),
        lid,
        scaleX,
        scaleY,
        rotate,
        lift,
        // Lit while it sleeps, like the terminal's; blinking once awake.
        cursor: life < 0.5 || (now - start) % CURSOR_BLINK_MS < CURSOR_BLINK_MS / 2,
        vivid: life,
      };
      const drawing = drawingOf(next);
      if (drawing !== drawn) {
        drawn = drawing;
        setPose(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const onPointerMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.last = performance.now();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    const onPointerDown = (e: PointerEvent) => {
      const rect = optionsRef.current.frogRect();
      if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        startHunt();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);

    const schedule = () => {
      later(() => {
        if (!optionsRef.current.awake) {
          schedule();
          return;
        }
        if (Math.random() < 0.55) {
          later(() => {
            blink = { at: performance.now(), times: Math.random() < 0.25 ? 2 : 1 };
          }, Math.random() * 400);
        }
        if (Math.random() < 0.3) {
          const kinds: Action[] = ["hop", "tilt", "puff", "look", "look"];
          act(kinds[Math.floor(Math.random() * kinds.length)]);
        }
        schedule();
      }, 1800 + Math.random() * 2600);
    };
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(window.clearTimeout);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      huntWordRef.current = () => false;
      setPose(REST_POSE);
      setCatching(null);
    };
  }, [active]);

  return { pose, catching, huntWord: (word, spot, onCatch) => huntWordRef.current(word, spot, onCatch) };
}
