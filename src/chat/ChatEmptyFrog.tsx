// The New Tab's frog, alone in the middle of a chat with nothing in it yet -
// shared by the desktop and the phone. Still, like the one beside the
// wordmark, until the pointer comes over it or it's tapped.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FROG_PIXELS, REST_POSE, drawFrog } from "../terminal/frogArt";
import { useFrogPose } from "../newtab/useFrogPose";
import "./chat-empty-frog.css";

/** CSS px per frog pixel. */
const PIXEL = 4;
const WIDTH = FROG_PIXELS.width * PIXEL;
const HEIGHT = FROG_PIXELS.height * PIXEL;
/** How long the frog stays awake once the pointer has left it (or the tap ended). */
const AWAKE_MS = 3000;

export function ChatEmptyFrog({ hidden = false }: { hidden?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [awake, setAwake] = useState(false);
  const sleepTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(sleepTimerRef.current), []);

  const wake = () => {
    window.clearTimeout(sleepTimerRef.current);
    setAwake(true);
  };
  const letSleep = () => {
    window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = window.setTimeout(() => setAwake(false), AWAKE_MS);
  };

  // No catches here: no fly area, no caret to watch.
  const { pose } = useFrogPose({
    active: !hidden,
    awake,
    frogRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    caret: () => null,
    flyArea: () => null,
  });

  const shownPose = hidden ? REST_POSE : pose;
  const redraw = () => {
    if (canvasRef.current) drawFrog(canvasRef.current, shownPose, WIDTH, HEIGHT);
  };
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  useLayoutEffect(redraw, [shownPose]);
  // Its colors follow the theme's accent: redraw when the theme changes it.
  useEffect(() => {
    const observer = new MutationObserver(() => redrawRef.current());
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="chat-empty-frog">
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
