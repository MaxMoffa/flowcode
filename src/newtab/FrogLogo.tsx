import { useEffect, useRef, type CSSProperties } from "react";
import { FROG_BOX } from "../terminal/asciiBanner";

/** The app icon's frog (public/flowcode-icon.svg) without its rounded
 * square, alive: the pupils follow the pointer - or the caret while the
 * user types - and it breathes, blinks and now and then hops, tilts its
 * head, puffs up or looks around. Hovering it makes it hop. Drawn over
 * FROG_BOX, the same box the banner's ASCII frog fills, so the two line up. */

// Pupil travel, in the SVG's own units (sclera r=85, pupil r=45).
const MAX_LOOK = 30;
// After this long without the pointer moving, the frog looks back ahead.
const POINTER_IDLE_MS = 4000;
const VIEWBOX_WIDTH = FROG_BOX.width;

const SHAPES = (
  <>
    <circle cx="340" cy="400" r="135" />
    <circle cx="684" cy="400" r="135" />
    <ellipse cx="512" cy="610" rx="360" ry="220" />
  </>
);

function Eye({ cx }: { cx: number }) {
  return (
    <g className="frog-eye">
      <circle className="frog-sclera" cx={cx} cy="393" r="85" fill="#FFFFFF" />
      <g className="frog-pupil" transform="translate(22 15)">
        <circle cx={cx} cy="393" r="45" fill="#14532D" />
        <circle cx={cx + 14} cy="378" r="11" fill="#FFFFFF" />
      </g>
      <circle className="frog-lid" cx={cx} cy="393" r="89" fill="#A3E635" />
    </g>
  );
}

type Action = "hop" | "tilt" | "puff" | "look";

export function FrogLogo({ className, style }: { className?: string; style?: CSSProperties }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const body = svg.querySelector<SVGGElement>(".frog-act")!;
    const eyes = Array.from(svg.querySelectorAll<SVGGElement>(".frog-eye")).map((el) => ({
      sclera: el.querySelector<SVGCircleElement>(".frog-sclera")!,
      pupil: el.querySelector<SVGGElement>(".frog-pupil")!,
      lid: el.querySelector<SVGCircleElement>(".frog-lid")!,
      x: 22,
      y: 15,
    }));
    const pointer = { x: 0, y: 0, last: -Infinity };
    let glance: { x: number; y: number; until: number } | null = null;
    let frame = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    const aim = (dx: number, dy: number, unit: number): [number, number] => {
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, (dist * unit) / 900) * MAX_LOOK;
      return [(dx / dist) * reach, (dy / dist) * reach];
    };

    const tick = (now: number) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width) {
        const unit = VIEWBOX_WIDTH / rect.width;
        const focused = document.activeElement;
        const typing =
          focused instanceof HTMLInputElement && focused.classList.contains("newtab-input") ? focused : null;
        const idle = now - pointer.last > POINTER_IDLE_MS;
        for (const eye of eyes) {
          let tx = 0;
          let ty = 6;
          const c = eye.sclera.getBoundingClientRect();
          const cx = c.left + c.width / 2;
          const cy = c.top + c.height / 2;
          if (glance && now < glance.until) {
            tx = glance.x;
            ty = glance.y;
          } else if (typing && now - pointer.last > 600) {
            const r = typing.getBoundingClientRect();
            const caretX = r.left + Math.min(r.width, 12 + typing.value.length * 8);
            [tx, ty] = aim(caretX - cx, r.top + r.height / 2 - cy, unit);
          } else if (!idle) {
            [tx, ty] = aim(pointer.x - cx, pointer.y - cy, unit);
          }
          eye.x += (tx - eye.x) * 0.18;
          eye.y += (ty - eye.y) * 0.18;
          eye.pupil.setAttribute("transform", `translate(${eye.x.toFixed(2)} ${eye.y.toFixed(2)})`);
        }
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

    const blink = (twice: boolean) => {
      for (const eye of eyes) {
        eye.lid.animate(
          [
            { transform: "scaleY(0)" },
            { transform: "scaleY(1)", offset: 0.45 },
            { transform: "scaleY(1)", offset: 0.55 },
            { transform: "scaleY(0)" },
          ],
          { duration: 190, iterations: twice ? 2 : 1, easing: "ease-in-out" },
        );
      }
    };

    const act = (kind: Action) => {
      if (reduceMotion || body.getAnimations().length) return;
      const ease = "cubic-bezier(.3,.7,.4,1)";
      if (kind === "hop") {
        body.animate(
          [
            { transform: "translateY(0) scale(1,1)" },
            { transform: "translateY(0) scale(1.08,.9)", offset: 0.18 },
            { transform: "translateY(-14%) scale(.95,1.06)", offset: 0.5 },
            { transform: "translateY(0) scale(1.06,.93)", offset: 0.82 },
            { transform: "translateY(0) scale(1,1)" },
          ],
          { duration: 620, easing: ease },
        );
      } else if (kind === "tilt") {
        const angle = Math.random() < 0.5 ? -8 : 8;
        body.animate(
          [
            { transform: "rotate(0)" },
            { transform: `rotate(${angle}deg)`, offset: 0.25 },
            { transform: `rotate(${angle}deg)`, offset: 0.75 },
            { transform: "rotate(0)" },
          ],
          { duration: 1600, easing: "ease-in-out" },
        );
      } else if (kind === "puff") {
        body.animate(
          [
            { transform: "scale(1,1)" },
            { transform: "scale(1.09,.94)", offset: 0.3 },
            { transform: "scale(1.02,.99)", offset: 0.5 },
            { transform: "scale(1.09,.94)", offset: 0.7 },
            { transform: "scale(1,1)" },
          ],
          { duration: 900, easing: "ease-in-out" },
        );
      } else {
        const side = Math.random() < 0.5 ? -1 : 1;
        glance = { x: MAX_LOOK * side, y: -4, until: performance.now() + 700 };
        later(() => {
          glance = { x: -MAX_LOOK * side, y: -4, until: performance.now() + 700 };
        }, 700);
      }
    };

    const schedule = () => {
      later(() => {
        if (Math.random() < 0.55) later(() => blink(Math.random() < 0.25), Math.random() * 400);
        if (Math.random() < 0.3) {
          const kinds: Action[] = ["hop", "tilt", "puff", "look", "look"];
          act(kinds[Math.floor(Math.random() * kinds.length)]);
        }
        schedule();
      }, 1800 + Math.random() * 2600);
    };
    schedule();

    const onEnter = () => act("hop");
    svg.addEventListener("pointerenter", onEnter);

    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      window.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerenter", onEnter);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      className={"frog-logo" + (className ? ` ${className}` : "")}
      style={style}
      viewBox={`${FROG_BOX.x} ${FROG_BOX.y} ${FROG_BOX.width} ${FROG_BOX.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g className="frog-act">
        <g className="frog-breathe">
          <g fill="#14532D" stroke="#14532D" strokeWidth="30" strokeLinejoin="round">
            {SHAPES}
          </g>
          <g fill="#A3E635">{SHAPES}</g>
          <Eye cx={340} />
          <Eye cx={684} />
          <g fill="none" stroke="#14532D" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round">
            <path d="M396 575 L472 632 L396 689" />
            <path className="frog-cursor" d="M526 689 L636 689" />
          </g>
        </g>
      </g>
    </svg>
  );
}
