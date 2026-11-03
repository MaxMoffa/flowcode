// The chat's footer when it can't take another message: the frog sinks back into its pond (the
// session ended) or waits on a lily pad for flies (the plan's usage limit, until it resets).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatLeft, runPondScene, type PondKind } from "../../src/chat/pondScene";
import { speechLocale, t } from "./i18n";
import "./chat-pond-end.css";

export function ChatPondEnd({ kind, resetAt, children }: { kind: PondKind; resetAt: number | null; children?: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The countdown only needs minutes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (kind !== "limit" || resetAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [kind, resetAt]);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    return runPondScene(box, canvas, kind, { hidden: false });
  }, [kind]);

  const reset =
    kind === "limit"
      ? resetAt === null
        ? t("pondLimitUnknown")
        : t("pondLimitReset", {
            time: new Date(resetAt).toLocaleTimeString(speechLocale(), { hour: "2-digit", minute: "2-digit" }),
            left: formatLeft(resetAt - now),
          })
      : null;

  return (
    <div className="chat-pond-end" ref={boxRef}>
      <canvas ref={canvasRef} className="chat-pond-end-scene" aria-hidden="true" />
      <div className="chat-pond-end-text" role="status">
        <h3>{t(kind === "ended" ? "pondEndedTitle" : "pondLimitTitle")}</h3>
        <p>
          {t(kind === "ended" ? "pondEndedBody" : "pondLimitBody")}
          {reset && <> {reset}</>}
        </p>
      </div>
      {children && <div className="chat-pond-end-actions">{children}</div>}
    </div>
  );
}
