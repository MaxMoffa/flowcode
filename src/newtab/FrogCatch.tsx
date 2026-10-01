import type { CSSProperties, ReactNode } from "react";
import { MOUTH, toWorld, tongueTip, type FrogScene, type Vec3 } from "./frog3d";
import type { CatchFrame } from "./frogHunt";

/** The catch drawn as SVG over the page - the FrogLogo frog, turned in 3D:
 * the scene's body and eye spheres are projected exactly (an ellipsoid seen
 * from the front is an ellipse), the `>_` follows the belly's curve, and
 * the tongue and the fly are drawn on top. Same colors and outline as the
 * logo, so the catch starts and ends on the frog that was there.
 *
 * Everything is in the frog's drawing units (FROG_BOX): the SVG's viewBox
 * maps them onto the page the way the banner's cell grid does. */

const GREEN = "#A3E635";
const DARK = "#14532D";
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

function shape(e: Ellipse, props: Record<string, string | number> = {}, key?: string | number) {
  return (
    <ellipse
      key={key}
      cx={e.cx}
      cy={e.cy}
      rx={e.rx}
      ry={e.ry}
      transform={`rotate(${e.angle.toFixed(2)} ${e.cx.toFixed(1)} ${e.cy.toFixed(1)})`}
      {...props}
    />
  );
}

/** A point of the belly's front at (x, y), on the body's surface. */
function onBelly(x: number, y: number): Vec3 {
  const [cx, cy, cz] = BODY.c;
  const [rx, ry, rz] = BODY.r;
  const k = 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2;
  return [x, y, cz + rz * Math.sqrt(Math.max(0, k))];
}

/** The `>_` painted on the belly, bent round it: each stroke as a polyline. */
function bellyMark(s: FrogScene): string[] {
  const strokes: [number, number, number, number][] = [
    [396, 575, 472, 632],
    [472, 632, 396, 689],
  ];
  const along = ([ax, ay, bx, by]: [number, number, number, number]) =>
    Array.from({ length: 7 }, (_, i) => {
      const t = i / 6;
      const [x, y] = toWorld(onBelly(ax + (bx - ax) * t, ay + (by - ay) * t), s);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
  // The chevron as one line, so its corner joins round.
  const chevron = [...along(strokes[0]), ...along(strokes[1]).slice(1)].join(" ");
  const out = [chevron];
  if (s.cursor) out.push(along([526, 689, 636, 689]).join(" "));
  return out;
}

function Frog({ scene }: { scene: FrogScene }) {
  const body = project(BODY.c, BODY.r, scene);
  const bumps = EYES.map((cx) => sphere([cx, 400, EYE_Z], 135, scene));
  const green = [body, ...bumps];
  // Each eye: its white, pupil and glint, nearer eye drawn last.
  const eyes = EYES.map((cx, i) => {
    const pupil: Vec3 = [cx + scene.lookX, 393 + scene.lookY, EYE_Z + 215];
    return {
      z: bumps[i].z,
      parts: [
        shape(sphere([cx, 393, EYE_Z + 140], 85, scene), { fill: "#FFFFFF" }, "white"),
        shape(sphere(pupil, 45, scene), { fill: DARK }, "pupil"),
        shape(sphere([pupil[0] + 14, pupil[1] - 15, pupil[2] + 40], 11, scene), { fill: "#FFFFFF" }, "glint"),
      ],
    };
  }).sort((a, b) => a.z - b.z);
  return (
    <>
      <g fill={DARK} stroke={DARK} strokeWidth={OUTLINE} strokeLinejoin="round">
        {green.map((e, i) => shape(e, {}, i))}
      </g>
      <g fill={GREEN}>{green.map((e, i) => shape(e, {}, i))}</g>
      {eyes.map((eye, i) => (
        <g key={i}>{eye.parts}</g>
      ))}
      <g fill="none" stroke={DARK} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
        {bellyMark(scene).map((points, i) => (
          <polyline key={i} points={points} />
        ))}
      </g>
    </>
  );
}

function Tongue({ scene }: { scene: FrogScene }) {
  const tip = tongueTip(scene);
  if (!tip || Math.hypot(...sub(tip, MOUTH)) <= 30) return null;
  const [mx, my] = toWorld(MOUTH, scene);
  const [tx, ty] = toWorld(tip, scene);
  const d = `M${mx.toFixed(1)} ${my.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)}`;
  return (
    <g strokeLinecap="round">
      <path d={d} stroke={DARK} strokeWidth={STROKE + OUTLINE} />
      <circle cx={tx} cy={ty} r={34 + OUTLINE / 2} fill={DARK} />
      <path d={d} stroke={PINK} strokeWidth={STROKE} />
      <circle cx={tx} cy={ty} r={34} fill={PINK} />
    </g>
  );
}

/** The fly: a dark body and head, two glassy wings beating up while it
 * flies and folded down while it sits - or, for a word off the prompt, the
 * word on a pink tag. */
function Fly({ fly, unitsPerCell }: { fly: NonNullable<CatchFrame["fly"]>; unitsPerCell: { x: number; y: number } }) {
  if (fly.word) {
    const width = (fly.word.length + 1) * unitsPerCell.x;
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
  const wing = (side: -1 | 1): ReactNode => (
    <ellipse
      cx={side * 16}
      cy={-10}
      rx={18}
      ry={8}
      transform={`rotate(${side * (fly.flap ? -35 : 18)})`}
      fill="rgba(220, 232, 255, 0.7)"
      stroke="rgba(255, 255, 255, 0.8)"
      strokeWidth={2}
    />
  );
  return (
    <g transform={`translate(${fly.x.toFixed(1)} ${fly.y.toFixed(1)})`}>
      {wing(-1)}
      {wing(1)}
      <ellipse cx={2} cy={2} rx={14} ry={10} fill="#27272A" />
      <circle cx={-12} cy={0} r={7} fill="#52525B" />
    </g>
  );
}

export function FrogCatch({
  frame,
  viewBox,
  unitsPerCell,
  frogOpacity = 1,
  style,
}: {
  frame: CatchFrame;
  viewBox: { x: number; y: number; width: number; height: number };
  unitsPerCell: { x: number; y: number };
  /** Below 1 while the real frog (painted under it) shows through. */
  frogOpacity?: number;
  style?: CSSProperties;
}) {
  const { scene, fly } = frame;
  return (
    <svg
      className="newtab-catch"
      style={style}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {frogOpacity > 0 && (
        <g opacity={frogOpacity}>
          <Frog scene={scene} />
          <Tongue scene={scene} />
        </g>
      )}
      {fly && <Fly fly={fly} unitsPerCell={unitsPerCell} />}
    </svg>
  );
}
