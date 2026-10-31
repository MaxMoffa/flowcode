// The New Tab's frog, alone in the middle of a chat with nothing in it yet -
// shared by the desktop and the phone. Still, like the one beside the
// wordmark, until the pointer comes over it or it's tapped. Two scenes play
// over it: while the agent starts (it floats in a pond, eyes out, and climbs
// out when ready) and after a clear (ripples, and it surfaces).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FROG_PIXELS, REST_POSE, drawFrog, frogPalette } from "../terminal/frogArt";
import { useFrogPose } from "../newtab/useFrogPose";
import { RING_SQUASH, clearFrame, loadFrame, poseOf, type Ring } from "./frogScenes";
import "./chat-empty-frog.css";

/** CSS px per frog pixel. */
const PIXEL = 4;
const WIDTH = FROG_PIXELS.width * PIXEL;
const HEIGHT = FROG_PIXELS.height * PIXEL;
/** How long the frog stays awake once the pointer has left it (or the tap ended). */
const AWAKE_MS = 3000;

interface Scene {
  kind: "clear" | "load" | null;
  t0: number;
  /** For the load scene: when (ms into it) the agent became ready. */
  readyAt: number | null;
  /** A scene has played here: none starts again. */
  played: boolean;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function startScene(kind: "clear" | "load"): Scene {
  return { kind, t0: performance.now(), readyAt: null, played: true };
}

/** The ripples as squares of the frog's pixel grid, centered on a frog whose top left is (left, top). */
function drawRings(ctx: CanvasRenderingContext2D, rings: Ring[], left: number, top: number, color: string) {
  ctx.fillStyle = color;
  for (const ring of rings) {
    ctx.globalAlpha = ring.alpha;
    const n = Math.max(12, Math.round(ring.r * 8));
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const gx = Math.round(ring.x + Math.cos(a) * ring.r);
      const gy = Math.round(ring.y + Math.sin(a) * ring.r * RING_SQUASH);
      const key = `${gx},${gy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.fillRect(left + gx * PIXEL, top + gy * PIXEL, PIXEL, PIXEL);
    }
  }
  ctx.globalAlpha = 1;
}

export function ChatEmptyFrog({ hidden = false, starting = false, cleared = false }: { hidden?: boolean; starting?: boolean; cleared?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringsRef = useRef<HTMLCanvasElement>(null);
  const [awake, setAwake] = useState(false);
  const sleepTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(sleepTimerRef.current), []);

  const sceneRef = useRef<Scene | null>(null);
  if (sceneRef.current === null) {
    const first = !reducedMotion() && (cleared || starting) ? startScene(cleared ? "clear" : "load") : null;
    sceneRef.current = first ?? { kind: null, t0: 0, readyAt: null, played: false };
  }
  const [playing, setPlaying] = useState(sceneRef.current.kind !== null);

  // What the props ask of the scene: a clear wins over the load; the load ends its loop when the agent is ready.
  useLayoutEffect(() => {
    const scene = sceneRef.current!;
    if (reducedMotion()) return;
    if (cleared && scene.kind !== "clear" && !(scene.played && scene.kind === null)) {
      sceneRef.current = startScene("clear");
      setPlaying(true);
    } else if (starting && !cleared && !scene.played) {
      sceneRef.current = startScene("load");
      setPlaying(true);
    }
    const now = sceneRef.current!;
    if (!starting && now.kind === "load" && now.readyAt === null) now.readyAt = performance.now() - now.t0;
  }, [starting, cleared]);

  const wake = () => {
    window.clearTimeout(sleepTimerRef.current);
    setAwake(true);
  };
  const letSleep = () => {
    window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = window.setTimeout(() => setAwake(false), AWAKE_MS);
  };

  // No catches here: no fly area, no caret to watch. The scenes draw the frog themselves.
  const { pose } = useFrogPose({
    active: !hidden && !playing,
    awake,
    frogRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    caret: () => null,
    flyArea: () => null,
  });

  const shownPose = hidden ? REST_POSE : pose;
  const redraw = () => {
    if (canvasRef.current && (!playing || hidden)) drawFrog(canvasRef.current, shownPose, WIDTH, HEIGHT);
  };
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  useLayoutEffect(redraw, [shownPose, playing]);
  // Its colors follow the theme's accent: redraw when the theme changes it.
  useEffect(() => {
    const observer = new MutationObserver(() => redrawRef.current());
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  // The scene's frames. Stops with the page hidden or the frog handed over; the accent is read at each frame.
  useEffect(() => {
    if (!playing || hidden) return;
    let frame = 0;
    const paint = () => {
      const scene = sceneRef.current!;
      const frog = canvasRef.current;
      const overlay = ringsRef.current;
      const wrap = wrapRef.current;
      if (!frog || !overlay || !wrap || scene.kind === null) return;
      const t = performance.now() - scene.t0;
      const f = scene.kind === "clear" ? clearFrame(t) : loadFrame(t, scene.readyAt);
      if (f.done) {
        overlay.getContext("2d")!.clearRect(0, 0, overlay.width, overlay.height);
        sceneRef.current = { ...scene, kind: null };
        setPlaying(false);
        return;
      }
      // The frog, cut at the water line.
      if (f.show) {
        drawFrog(frog, poseOf(f), WIDTH, HEIGHT);
        if (f.waterline !== null) frog.getContext("2d")!.clearRect(0, Math.round(f.waterline * frog.height), frog.width, frog.height);
      } else {
        frog.getContext("2d")!.clearRect(0, 0, frog.width, frog.height);
      }
      // The ripples, over the whole area, centered on the frog.
      const dpr = window.devicePixelRatio || 1;
      const [w, h] = [wrap.clientWidth, wrap.clientHeight];
      if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
        overlay.width = Math.round(w * dpr);
        overlay.height = Math.round(h * dpr);
      }
      const ctx = overlay.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // On the frog's own pixel grid.
      const [fr, wr] = [frog.getBoundingClientRect(), wrap.getBoundingClientRect()];
      const left = fr.left - wr.left;
      const top = fr.top - wr.top;
      drawRings(ctx, f.rings, left, top, `#${frogPalette(1, frog).green}`);
    };
    const tick = () => {
      paint();
      frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [playing, hidden]);

  return (
    <div className="chat-empty-frog" ref={wrapRef}>
      <canvas ref={ringsRef} className="chat-empty-frog-rings" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ width: WIDTH, height: HEIGHT }}
        onPointerEnter={wake}
        onPointerLeave={letSleep}
        onPointerDown={(e) => {
          wake();
          // A finger has no hover to keep it awake: it dozes off a while after the tap.
          if (e.pointerType !== "mouse") letSleep();
        }}
      />
    </div>
  );
}
