import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t } from "../i18n";

type PdfJs = typeof import("pdfjs-dist");

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.2;
const PAD = 16;

let pdfJsPromise: Promise<PdfJs> | null = null;
/** The legacy build runs on the older WebKitGTK of some Linux distros. */
function loadPdfJs(): Promise<PdfJs> {
  pdfJsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  });
  return pdfJsPromise;
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

interface Props {
  src: string;
  reloadNonce: number;
  onLoading: (busy: boolean) => void;
  onOpenExternal: () => void;
}

export default function PdfViewer({ src, reloadNonce, onLoading, onOpenExternal }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  /** Size of page 1 at scale 1: the placeholder size of pages not rendered yet. */
  const [baseSize, setBaseSize] = useState<[number, number]>([612, 792]);
  const [fit, setFit] = useState(true);
  const [manualScale, setManualScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const ratios = useRef(new Map<number, number>());
  const onLoadingRef = useRef(onLoading);
  onLoadingRef.current = onLoading;

  const scale = fit ? clampScale(Math.max(containerWidth - PAD * 2, 50) / baseSize[0]) : manualScale;
  const numPages = doc?.numPages ?? 0;

  useEffect(() => {
    let stale = false;
    let task: { destroy(): Promise<void> } | null = null;
    onLoadingRef.current(true);
    (async () => {
      try {
        const lib = await loadPdfJs();
        const buf = await invoke<ArrayBuffer>("preview_pdf_bytes", { source: src });
        if (stale) return;
        const loading = lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false } as Parameters<PdfJs["getDocument"]>[0]);
        task = loading;
        const loaded = await loading.promise;
        if (stale) return;
        const first = await loaded.getPage(1);
        const view = first.getViewport({ scale: 1 });
        if (stale) return;
        setPdfjs(lib);
        setBaseSize([view.width, view.height]);
        setDoc(loaded);
        setError(false);
      } catch {
        if (!stale) setError(true);
      } finally {
        if (!stale) onLoadingRef.current(false);
      }
    })();
    return () => {
      stale = true;
      void task?.destroy().catch(() => {});
    };
  }, [src, reloadNonce]);

  useEffect(() => () => onLoadingRef.current(false), []);

  // Fit width follows the container.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [!!doc]);

  // Keep the reading position when the zoom changes.
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevScale.current !== scale) el.scrollTop = (el.scrollTop * scale) / prevScale.current;
    prevScale.current = scale;
  }, [scale]);

  const zoomTo = useCallback((next: number) => {
    setFit(false);
    setManualScale(clampScale(next));
  }, []);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Ctrl+wheel zooms; the listener can't be passive to cancel the page zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(scaleRef.current * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, !!doc]);

  const onRatio = useCallback((page: number, ratio: number) => {
    ratios.current.set(page, ratio);
    let best = 0;
    let bestRatio = -1;
    for (const [p, r] of ratios.current) {
      if (r > bestRatio || (r === bestRatio && p < best)) {
        best = p;
        bestRatio = r;
      }
    }
    if (best > 0 && bestRatio > 0) setCurrent(best);
  }, []);

  useEffect(() => {
    ratios.current.clear();
    setCurrent(1);
  }, [doc]);

  const jumpTo = (value: string) => {
    setPageDraft(null);
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || numPages === 0) return;
    const page = Math.min(numPages, Math.max(1, n));
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (el && target) el.scrollTop = target.offsetTop - PAD;
    setCurrent(page);
  };

  return (
    <div className="pdf-viewer">
      {doc && pdfjs && !error && (
        <div className="pdf-viewer-toolbar">
          <span className="pdf-viewer-pager">
            <input
              className="pdf-viewer-page-input"
              inputMode="numeric"
              aria-label={t("browser.pdf.page")}
              title={t("browser.pdf.page")}
              value={pageDraft ?? String(current)}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setPageDraft(e.target.value)}
              onBlur={(e) => pageDraft !== null && jumpTo(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") jumpTo(e.currentTarget.value);
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setPageDraft(null);
                  e.currentTarget.blur();
                }
              }}
            />
            <span>{` / ${numPages}`}</span>
          </span>
          <span className="pdf-viewer-spacer" />
          <button type="button" className="icon-button sm" onClick={() => zoomTo(scale / ZOOM_STEP)} disabled={scale <= MIN_SCALE} title={t("browser.pdf.zoomOut")} aria-label={t("browser.pdf.zoomOut")}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <span className="pdf-viewer-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" className="icon-button sm" onClick={() => zoomTo(scale * ZOOM_STEP)} disabled={scale >= MAX_SCALE} title={t("browser.pdf.zoomIn")} aria-label={t("browser.pdf.zoomIn")}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M5 12h14M12 5v14" />
            </svg>
          </button>
          <button type="button" className={"icon-button sm" + (fit ? " is-active" : "")} onClick={() => setFit(true)} title={t("browser.pdf.fitWidth")} aria-label={t("browser.pdf.fitWidth")} aria-pressed={fit}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5v14M20 5v14M8 12h8M10 9l-2 3 2 3M14 9l2 3-2 3" />
            </svg>
          </button>
        </div>
      )}
      <div className="pdf-viewer-scroll" ref={scrollRef}>
        {doc &&
          Array.from({ length: numPages }, (_, i) => (
            <PdfPage key={i + 1} doc={doc} pdfjs={pdfjs} num={i + 1} scale={scale} baseSize={baseSize} root={scrollRef} onRatio={onRatio} />
          ))}
      </div>
      {error && (
        <div className="browser-panel-state">
          <div className="browser-panel-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
            </svg>
          </div>
          <h4>{t("browser.pdf.error.title")}</h4>
          <p>{t("browser.pdf.error.text")}</p>
          <div className="browser-panel-state-actions">
            <button type="button" className="browser-panel-btn is-primary" onClick={onOpenExternal}>
              {t("browser.pdf.openExternal")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  pdfjs: PdfJs | null;
  num: number;
  scale: number;
  baseSize: [number, number];
  root: React.RefObject<HTMLDivElement | null>;
  onRatio: (page: number, ratio: number) => void;
}

function PdfPage({ doc, pdfjs, num, scale, baseSize, root, onRatio }: PageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState<[number, number] | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    const rootEl = root.current;
    if (!el || !rootEl) return;
    const nearObserver = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), { root: rootEl, rootMargin: "100% 0px" });
    const ratioObserver = new IntersectionObserver((entries) => onRatio(num, entries[entries.length - 1].intersectionRatio), {
      root: rootEl,
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
    nearObserver.observe(el);
    ratioObserver.observe(el);
    return () => {
      nearObserver.disconnect();
      ratioObserver.disconnect();
      onRatio(num, 0);
    };
  }, [root, num, onRatio]);

  useEffect(() => {
    if (!near || !pdfjs) return;
    let stale = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
    let textLayer: { cancel(): void } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(num);
        if (stale) return;
        const view = page.getViewport({ scale });
        const unit = page.getViewport({ scale: 1 });
        setSize([unit.width, unit.height]);
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(view.width * dpr);
        canvas.height = Math.floor(view.height * dpr);
        canvas.style.width = `${view.width}px`;
        canvas.style.height = `${view.height}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTask = page.render({ canvas, canvasContext: ctx, viewport: view, transform: [dpr, 0, 0, dpr, 0, 0] });
        await renderTask.promise;
        if (stale) return;

        const textDiv = document.createElement("div");
        textDiv.className = "textLayer";
        textDiv.style.setProperty("--scale-factor", String(view.scale));
        textDiv.style.setProperty("--total-scale-factor", String(view.scale));
        textDiv.style.width = `${view.width}px`;
        textDiv.style.height = `${view.height}px`;
        holderRef.current?.replaceChildren(canvas, textDiv);
        try {
          const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: view });
          textLayer = layer;
          await layer.render();
        } catch {
          /* text selection is a bonus: the page stays readable without it */
        }
      } catch {
        /* cancelled by a zoom, a reload or a closed document */
      }
    })();
    return () => {
      stale = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pdfjs, near, num, scale]);

  // Far from the viewport the bitmap is dropped; the placeholder keeps the height.
  useEffect(() => {
    if (!near) holderRef.current?.replaceChildren();
  }, [near]);

  const [w, h] = size ?? baseSize;
  return (
    <div ref={wrapRef} className="pdf-viewer-page" data-page={num} style={{ width: w * scale, height: h * scale }}>
      <div ref={holderRef} className="pdf-viewer-page-holder" />
    </div>
  );
}
