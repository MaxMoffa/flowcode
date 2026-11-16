import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEventHandler } from "react";
import { useI18n } from "../i18n";
import { fitScale, zoomAt, type ImageTransform } from "./zoomMath";
import "./image-view.css";

const INITIAL: ImageTransform = { fit: true, scale: 1, tx: 0, ty: 0 };

export function useZoomPan(src: string | null) {
  const stageRef = useRef<HTMLDivElement>(null);
  const natural = useRef({ width: 0, height: 0 });
  const [transform, setTransform] = useState(INITIAL);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);
  const startedBlank = useRef(false);
  const getFit = useCallback(() => {
    const stage = stageRef.current;
    return stage ? fitScale(stage.clientWidth, stage.clientHeight, natural.current.width, natural.current.height) : 1;
  }, []);
  const fit = useCallback(() => setTransform({ fit: true, scale: getFit(), tx: 0, ty: 0 }), [getFit]);
  const actual = useCallback(() => setTransform({ fit: false, scale: 1, tx: 0, ty: 0 }), []);
  const zoomBy = useCallback((factor: number) => setTransform((prev) => zoomAt(prev, prev.scale * factor)), []);
  useLayoutEffect(() => {
    natural.current = { width: 0, height: 0 };
    setLoadedSrc(null);
    setTransform(INITIAL);
    drag.current = null;
    moved.current = false;
    setDragging(false);
  }, [src]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setTransform((prev) => prev.fit ? { fit: true, scale: getFit(), tx: 0, ty: 0 } : prev));
    observer.observe(stage);
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest("button") || !natural.current.width) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      setTransform((prev) => zoomAt(prev, prev.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2));
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); stage.removeEventListener("wheel", wheel); };
  }, [getFit]);
  return { stageRef, natural, transform, setTransform, loadedSrc, setLoadedSrc, dragging, setDragging, drag, moved, startedBlank, fit, actual, zoomBy };
}

type ZoomPan = ReturnType<typeof useZoomPan>;

export function ImageButton({ title, onClick, active, disabled, children }: { title: string; onClick: MouseEventHandler<HTMLButtonElement>; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className={"image-view-button" + (active ? " is-on" : "")} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function ImageSeparator() { return <span className="image-view-separator" aria-hidden="true" />; }

export function ZoomControls({ zoom }: { zoom: ZoomPan }) {
  const { t } = useI18n();
  const disabled = !zoom.loadedSrc;
  return <>
    <span className="image-view-zoom">
      <ImageButton title={t("image.zoomOut")} disabled={disabled} onClick={() => zoom.zoomBy(0.8)}><svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg></ImageButton>
      <span className="image-view-percent">{zoom.transform.fit ? t("image.fit") : `${Math.round(zoom.transform.scale * 100)} %`}</span>
      <ImageButton title={t("image.zoomIn")} disabled={disabled} onClick={() => zoom.zoomBy(1.25)}><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" /></svg></ImageButton>
    </span>
    <ImageButton title={t("image.fitTitle")} active={zoom.transform.fit} disabled={disabled} onClick={zoom.fit}><svg viewBox="0 0 24 24"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5M8 8h8v8H8z" /></svg></ImageButton>
    <ImageButton title={t("image.actual")} active={!zoom.transform.fit && zoom.transform.scale === 1} disabled={disabled} onClick={zoom.actual}><span className="image-view-one">1:1</span></ImageButton>
  </>;
}

/** The image never participates in layout; even very large originals fit the stage. */
export function ZoomStage({ zoom, src, alt, className = "", onDims, onError, onBlankClick, children }: { zoom: ZoomPan; src: string | null; alt: string; className?: string; onDims?: (width: number, height: number) => void; onError?: () => void; onBlankClick?: () => void; children?: ReactNode }) {
  const { transform, natural } = zoom;
  return <div ref={zoom.stageRef} className={`image-view-stage ${className}${!transform.fit ? " is-pannable" : ""}${zoom.dragging ? " is-dragging" : ""}`}
    onPointerDown={(event) => {
      if ((event.target as Element).closest("button") || event.button !== 0) return;
      zoom.moved.current = false;
      zoom.startedBlank.current = event.target === event.currentTarget;
      zoom.drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: transform.tx, ty: transform.ty };
      if (transform.fit) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      zoom.setDragging(true);
    }}
    onPointerMove={(event) => {
      const drag = zoom.drag.current;
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) zoom.moved.current = true;
      if (zoom.moved.current && !transform.fit) zoom.setTransform((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }));
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      zoom.drag.current = null;
      zoom.setDragging(false);
    }}
    onLostPointerCapture={() => { zoom.drag.current = null; zoom.setDragging(false); }}
    onPointerCancel={() => { zoom.drag.current = null; zoom.moved.current = true; zoom.setDragging(false); }}
    onDoubleClick={(event) => { if ((event.target as Element).closest("button")) return; transform.fit ? zoom.actual() : zoom.fit(); }}
    onClick={(event) => { if (event.target === event.currentTarget && zoom.startedBlank.current && !zoom.moved.current) onBlankClick?.(); }}>
    {src && <img key={src} src={src} alt={alt} draggable={false} className="image-view-image"
      style={{ width: natural.current.width || undefined, height: natural.current.height || undefined, visibility: zoom.loadedSrc === src ? "visible" : "hidden", transform: `translate(-50%, -50%) translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})` }}
      onLoad={(event) => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        natural.current = { width, height };
        zoom.setLoadedSrc(src);
        zoom.fit();
        onDims?.(width, height);
      }} onError={onError} />}
    {children}
  </div>;
}
