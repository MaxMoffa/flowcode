// The chat's footer when it can't take another message: the frog sinks back
// into its pond (the session ended) or waits on a lily pad for flies (the
// plan's usage limit is reached, so no turn can run until it resets).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatLeft, runPondScene, type PondKind } from "./pondScene";
import { useI18n } from "../i18n";
import "./chat-pond-end.css";

export function ChatPondEnd({ kind, resetAt, hidden = false, children }: { kind: PondKind; resetAt: number | null; hidden?: boolean; children: ReactNode }) {
  const { t, language } = useI18n();
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
    return runPondScene(box, canvas, kind, { hidden });
  }, [kind, hidden]);

  const title = t(kind === "ended" ? "chat.pond.ended.title" : "chat.pond.limit.title");
  const body = t(kind === "ended" ? "chat.pond.ended.body" : "chat.pond.limit.body");
  const reset =
    kind === "limit"
      ? resetAt === null
        ? t("chat.pond.limit.unknown")
        : t("chat.pond.limit.reset", {
            time: new Date(resetAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
            left: formatLeft(resetAt - now),
          })
      : null;

  return (
    <div className="chat-pond-end" ref={boxRef}>
      <canvas ref={canvasRef} className="chat-pond-end-scene" aria-hidden="true" />
      <div className="chat-pond-end-text" role="status">
        <h3>{title}</h3>
        <p>
          {body}
          {reset && <> {reset}</>}
        </p>
      </div>
      <div className="chat-pond-end-actions">{children}</div>
    </div>
  );
}
