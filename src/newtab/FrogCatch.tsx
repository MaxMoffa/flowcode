import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { frogPalette } from "../terminal/asciiBanner";
import { MOUTH, toWorld, tongueTip, type FrogScene, type Vec3 } from "./frog3d";
import type { CatchFrame } from "./frogHunt";

/** The catch drawn over the page as pixel art, on the page frog's pixel
 * grid (two pixels across and four down a cell): the logo's frog, turned in
 * 3D - the scene's body and eye spheres are projected exactly (an ellipsoid
 * seen from the front is an ellipse), the `>_` follows the belly's curve -
 * with the tongue and the fly on top, drawn small and blown up square. Same
 * colors as the page frog, so the catch starts and ends on the frog that was
 * there. A word off the prompt rides the tongue as crisp text, to stay
 * readable.
 *
 * Everything is in the frog's drawing units (FROG_BOX): `viewBox` maps them
 * onto the page the way the banner's cell grid does. */

const PINK = "#F472B6";
const OUTLINE = 30;
const STROKE = 44;

const BODY = { c: [512, 610, 0] as Vec3, r: [360, 220, 260] as Vec3 };
const EYE_Z = 40;
const EYES = [340, 684];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
  z: number;
}

/** The outline of an ellipsoid (rest-frame center `c`, radii `r`) on
 * screen: its axes go through the scene's linear map, and the outline of
 * `A u` for unit `u` is the ellipse with shape matrix A Aᵀ. */
function project(c: Vec3, r: Vec3, s: FrogScene): Ellipse {
  const [cx, cy, z] = toWorld(c, s);
  const zero = toWorld([0, 0, 0], s);
  const axes = [0, 1, 2].map((i) => {
    const v: Vec3 = [0, 0, 0];
    v[i] = r[i];
    return sub(toWorld(v, s), zero);
  });
  const a = axes.reduce((sum, v) => sum + v[0] * v[0], 0);
  const b = axes.reduce((sum, v) => sum + v[0] * v[1], 0);
  const d = axes.reduce((sum, v) => sum + v[1] * v[1], 0);
  const mid = (a + d) / 2;
  const spread = Math.hypot((a - d) / 2, b);
  return {
    cx,
    cy,
    rx: Math.sqrt(mid + spread),
    ry: Math.sqrt(Math.max(0, mid - spread)),
    angle: (Math.atan2(2 * b, a - d) * 90) / Math.PI,
    z,
  };
}

const sphere = (c: Vec3, r: number, s: FrogScene) => project(c, [r, r, r], s);

/** A point of the belly's front at (x, y), on the body's surface. */
function onBelly(x: number, y: number): Vec3 {
  const [cx, cy, cz] = BODY.c;
  const [rx, ry, rz] = BODY.r;
  const k = 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2;
  return [x, y, cz + rz * Math.sqrt(Math.max(0, k))];
}

/** The `>_` painted on the belly, bent round it: each stroke as a polyline. */
function bellyMark(s: FrogScene): [number, number][][] {
  const strokes: [number, number, number, number][] = [
    [396, 575, 472, 632],
    [472, 632, 396, 689],
  ];
  const along = ([ax, ay, bx, by]: [number, number, number, number]) =>
    Array.from({ length: 7 }, (_, i): [number, number] => {
      const t = i / 6;
      const [x, y] = toWorld(onBelly(ax + (bx - ax) * t, ay + (by - ay) * t), s);
      return [x, y];
    });
  // The chevron as one line, so its corner joins round.
  const out = [[...along(strokes[0]), ...along(strokes[1]).slice(1)]];
  if (s.cursor) out.push(along([526, 689, 636, 689]));
  return out;
}

type Ctx = CanvasRenderingContext2D;
type Colors = { green: string; dark: string; white: string };

function ellipse(ctx: Ctx, e: Ellipse) {
  ctx.beginPath();
  ctx.ellipse(e.cx, e.cy, e.rx, e.ry, (e.angle * Math.PI) / 180, 0, 2 * Math.PI);
}

function drawFrog(ctx: Ctx, scene: FrogScene, c: Colors) {
  const body = project(BODY.c, BODY.r, scene);
  const bumps = EYES.map((cx) => sphere([cx, 400, EYE_Z], 135, scene));
  const green = [body, ...bumps];
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // No outline, like the page frog it turns from.
  ctx.fillStyle = c.green;
  for (const e of green) {
    ellipse(ctx, e);
    ctx.fill();
  }
  // Each eye: its white, pupil and glint, nearer eye drawn last.
  const eyes = EYES.map((cx, i) => {
    const pupil: Vec3 = [cx + scene.lookX, 393 + scene.lookY, EYE_Z + 215];
    const parts: [Ellipse, string][] = [
      [sphere([cx, 393, EYE_Z + 140], 85, scene), c.white],
      [sphere(pupil, 45, scene), c.dark],
      [sphere([pupil[0] + 14, pupil[1] - 15, pupil[2] + 40], 11, scene), c.white],
    ];
    return { z: bumps[i].z, parts };
  }).sort((a, b) => a.z - b.z);
  for (const eye of eyes) {
    for (const [e, color] of eye.parts) {
      ctx.fillStyle = color;
      ellipse(ctx, e);
      ctx.fill();
    }
  }
  ctx.strokeStyle = c.dark;
  ctx.lineWidth = STROKE;
  for (const points of bellyMark(scene)) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
}

function drawTongue(ctx: Ctx, scene: FrogScene, c: Colors) {
  const tip = tongueTip(scene);
  if (!tip || Math.hypot(...sub(tip, MOUTH)) <= 30) return;
  const [mx, my] = toWorld(MOUTH, scene);
  const [tx, ty] = toWorld(tip, scene);
  ctx.lineCap = "round";
  // Outlined in the dark green, like the frog: the outline first, wider.
  const layers: [string, number][] = [
    [c.dark, OUTLINE],
    [PINK, 0],
  ];
  for (const [color, grow] of layers) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = STROKE + grow;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 34 + grow / 2, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/** The fly: a dark body and head, two pale wings beating up while it flies
 * and folded down while it sits. */
function drawFly(ctx: Ctx, fly: NonNullable<CatchFrame["fly"]>) {
  ctx.save();
  ctx.translate(fly.x, fly.y);
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.rotate((side * (fly.flap ? -35 : 18) * Math.PI) / 180);
    ctx.fillStyle = "#DCE8FF";
    ctx.beginPath();
    ctx.ellipse(side * 16, -10, 18, 8, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = "#27272A";
  ctx.beginPath();
  ctx.ellipse(2, 2, 14, 10, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = "#52525B";
  ctx.beginPath();
  ctx.arc(-12, 0, 7, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

/** A word off the prompt, on a pink tag - crisp, over the pixels. */
function WordFly({ fly, unitsPerCell }: { fly: NonNullable<CatchFrame["fly"]>; unitsPerCell: { x: number; y: number } }) {
  const width = (fly.word!.length + 1) * unitsPerCell.x;
  const height = unitsPerCell.y;
  return (
    <g>
      <rect x={fly.x - width / 2} y={fly.y - height / 2} width={width} height={height} rx={height / 4} fill="#EC4899" />
      <text
        x={fly.x}
        y={fly.y}
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--fg)"
        fontFamily="Menlo, Consolas, monospace"
        fontWeight={700}
        fontSize={height * 0.8}
      >
        {fly.word}
      </text>
    </g>
  );
}

/** Paints `paint` (in drawing units, through `toPixels`) onto `small`, one
 * canvas pixel a frog pixel and hard-edged - each pixel all there or not at
 * all - then blows it up square over the whole of `ctx`. */
function pixelPass(
  small: HTMLCanvasElement,
  toPixels: DOMMatrix2DInit,
  ctx: Ctx,
  opacity: number,
  paint: (s: Ctx) => void,
) {
  const s = small.getContext("2d", { willReadFrequently: true })!;
  s.resetTransform();
  s.clearRect(0, 0, small.width, small.height);
  s.setTransform(toPixels);
  paint(s);
  const image = s.getImageData(0, 0, small.width, small.height);
  const data = image.data;
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] < 128 ? 0 : 255;
  s.putImageData(image, 0, 0);
  ctx.globalAlpha = opacity;
  ctx.drawImage(small, 0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalAlpha = 1;
}

export function FrogCatch({
  frame,
  viewBox,
  pixels,
  unitsPerCell,
  frogOpacity = 1,
  style,
}: {
  frame: CatchFrame;
  viewBox: { x: number; y: number; width: number; height: number };
  /** The page's frog pixels across and down the whole viewBox. */
  pixels: { width: number; height: number };
  unitsPerCell: { x: number; y: number };
  /** Below 1 while the real frog (painted under it) shows through. */
  frogOpacity?: number;
  style: CSSProperties & { width: number; height: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const smallRef = useRef<HTMLCanvasElement | null>(null);
  const { scene, fly } = frame;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(style.width * dpr);
    const h = Math.round(style.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const small = (smallRef.current ??= document.createElement("canvas"));
    if (small.width !== pixels.width || small.height !== pixels.height) {
      small.width = pixels.width;
      small.height = pixels.height;
    }
    const sx = pixels.width / viewBox.width;
    const sy = pixels.height / viewBox.height;
    const toPixels = { a: sx, b: 0, c: 0, d: sy, e: -viewBox.x * sx, f: -viewBox.y * sy };
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    const palette = frogPalette(frame.vivid ?? 1);
    const colors = { green: `#${palette.green}`, dark: `#${palette.dark}`, white: `#${palette.white}` };
    if (frogOpacity > 0) {
      pixelPass(small, toPixels, ctx, frogOpacity, (s) => {
        drawFrog(s, scene, colors);
        drawTongue(s, scene, colors);
      });
    }
    if (fly && !fly.word) pixelPass(small, toPixels, ctx, 1, (s) => drawFly(s, fly));
  });

  return (
    <>
      <canvas ref={canvasRef} className="newtab-catch" style={style} aria-hidden="true" />
      {fly?.word && (
        <svg
          className="newtab-catch"
          style={style}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <WordFly fly={fly} unitsPerCell={unitsPerCell} />
        </svg>
      )}
    </>
  );
}
