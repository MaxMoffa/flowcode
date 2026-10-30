import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChatImageRef } from "../../src/chat/chatTypes";
import { useBackHandler, useEscape } from "./back";
import { retryChatImage, useChatImage } from "./chatImages";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";

interface Registered {
  image: ChatImageRef;
  chatId?: string;
}

/** The images on screen by their element: the viewer reads them in DOM order. */
const registry = new WeakMap<Element, Registered>();

interface Ctx {
  chatId?: string;
  open: (el: HTMLElement) => void;
}
const ChatImagesContext = createContext<Ctx>({ open: () => {} });

/** The id of the chat whose images are drawn below. */
export const useChatId = () => useContext(ChatImagesContext).chatId;

/** The host of a web address (the address itself when it doesn't parse). */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const nameOf = (image: ChatImageRef) => image.name ?? (image.path ? image.path.split(/[\\/]/).pop() : undefined) ?? t("chatImgDefaultName");

/** Provides the chat id to the images below and owns the full-screen viewer. */
export function ChatImagesProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
  const [view, setView] = useState<{ items: Registered[]; index: number } | null>(null);
  const open = useCallback((el: HTMLElement) => {
    const root = el.closest(".chat-thread-inner") ?? document;
    const items: Registered[] = [];
    let index = 0;
    for (const e of Array.from(root.querySelectorAll("[data-chat-img]"))) {
      const r = registry.get(e);
      if (!r) continue;
      if (e === el) index = items.length;
      items.push(r);
    }
    if (items.length === 0) return;
    tapFeedback();
    setView({ items, index });
  }, []);
  const value = useMemo(() => ({ chatId, open }), [chatId, open]);
  return (
    <ChatImagesContext.Provider value={value}>
      {children}
      {view && <Viewer items={view.items} start={view.index} onClose={() => setView(null)} />}
    </ChatImagesContext.Provider>
  );
}

export type ChatImageVariant = "single" | "thumb" | "cell";

/** One image: its picture, a shimmer while it loads, or a "no longer available" tile (a tap asks again). A tap on a picture opens the viewer. `more` is the "+N" laid over a grid's last cell. */
export function ChatImageView({ image, chatId, variant, caption, more }: { image: ChatImageRef; chatId?: string; variant: ChatImageVariant; caption?: string; more?: number }) {
  const ctx = useContext(ChatImagesContext);
  const id = chatId ?? ctx.chatId;
  const { src, state } = useChatImage(image, id);
  const register = useCallback(
    (el: HTMLElement | null) => {
      if (el) registry.set(el, { image, chatId: id });
    },
    [image, id],
  );
  const cls = "chat-img" + (variant === "single" ? " is-single" : variant === "cell" ? " is-cell" : " is-thumb");
  if (state === "blocked") {
    return (
      <span className={cls + " is-missing"}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m21 16-5-5-8 8" />
        </svg>
        <span className="chat-img-missing-text">
          <span>{hostOf(image.url ?? "")}</span>
          <span className="chat-img-missing-sub">{t("chatImgBlocked")}</span>
          <span className="chat-img-missing-sub">{t("chatImgBlockedHint")}</span>
        </span>
      </span>
    );
  }
  if (state === "missing") {
    return (
      <button type="button" className={cls + " is-missing"} ref={register} data-chat-img="" onClick={() => retryChatImage(image, id)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m21 16-5-5-8 8" />
        </svg>
        <span className="chat-img-missing-text">
          <span>{nameOf(image)}</span>
          <span className="chat-img-missing-sub">{t("chatImgMissing")}</span>
        </span>
      </button>
    );
  }
  if (state === "loading" || !src) return <span className={cls + " is-loading"} ref={register} data-chat-img="" aria-hidden="true" />;
  return (
    <>
      <button type="button" className={cls} ref={register} data-chat-img="" aria-label={caption || nameOf(image)} onClick={(e) => ctx.open(e.currentTarget)}>
        <img src={src} alt={caption ?? ""} draggable={false} />
        {more !== undefined && more > 0 && <span className="chat-img-more">+{more}</span>}
      </button>
      {caption && <span className="chat-img-cap">{caption}</span>}
    </>
  );
}

/** Registers an image that has no cell of its own (past the grid's visible ones) so the viewer still reaches it. */
function HiddenImage({ image, chatId }: { image: ChatImageRef; chatId?: string }) {
  const ctx = useContext(ChatImagesContext);
  return <span hidden data-chat-img="" ref={(el) => void (el && registry.set(el, { image, chatId: chatId ?? ctx.chatId }))} />;
}

/** Cells of a phone's grid. */
const GRID_SHOWN = 3;

/** A reply's or tool's images: one alone at its ratio, several as a grid of three squares with "+N" on the last. */
export function ChatImages({ images, chatId }: { images: ChatImageRef[]; chatId?: string }) {
  if (images.length === 0) return null;
  if (images.length === 1) return <ChatImageView image={images[0]} chatId={chatId} variant="single" />;
  const extra = images.length - GRID_SHOWN;
  return (
    <div className="chat-img-grid">
      {images.slice(0, GRID_SHOWN).map((image, i) => (
        <ChatImageView key={i} image={image} chatId={chatId} variant="cell" more={i === GRID_SHOWN - 1 ? extra : undefined} />
      ))}
      {images.slice(GRID_SHOWN).map((image, i) => (
        <HiddenImage key={i} image={image} chatId={chatId} />
      ))}
    </div>
  );
}

/** The thumbnails of what the user attached, above their bubble. */
export function ChatUserImages({ images, chatId }: { images: ChatImageRef[]; chatId?: string }) {
  return (
    <div className="chat-user-images">
      {images.map((image, i) => (
        <ChatImageView key={i} image={image} chatId={chatId} variant="thumb" />
      ))}
    </div>
  );
}

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 10;
const SWIPE_PX = 60;

interface Pt {
  x: number;
  y: number;
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The bytes of the shown picture, for sharing or saving. */
async function blobOf(src: string): Promise<Blob | null> {
  try {
    return await (await fetch(src)).blob();
  } catch {
    return null;
  }
}

const canShareFiles = () => {
  try {
    return typeof navigator.canShare === "function" && typeof navigator.share === "function" && navigator.canShare({ files: [new File([], "a.png", { type: "image/png" })] });
  } catch {
    return false;
  }
};

/** Full-screen viewer over everything: swipe or arrows between the conversation's images, pinch and double tap to zoom, drag to pan when zoomed, Back closes. */
function Viewer({ items, start, onClose }: { items: Registered[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const item = items[index];
  const { src, state } = useChatImage(item.image, item.chatId);
  // The transform lives in a ref and is written to the element directly: a gesture would re-render on every move.
  const tf = useRef({ s: 1, x: 0, y: 0 });
  const imgRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const drag = useRef<{ start: Pt; last: Pt; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  useBackHandler(true, onClose);
  useEscape(true, onClose);

  const apply = (animate = false) => {
    const el = imgRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform 180ms ease-out" : "none";
    el.style.transform = `translate3d(${tf.current.x}px, ${tf.current.y}px, 0) scale(${tf.current.s})`;
  };
  /** Keeps a zoomed picture's edges from leaving the stage. */
  const clamp = () => {
    const cur = tf.current;
    const r = stageRef.current?.getBoundingClientRect();
    if (cur.s <= 1 || !r) {
      cur.s = 1;
      cur.y = 0;
      return;
    }
    const mx = (r.width * (cur.s - 1)) / 2;
    const my = (r.height * (cur.s - 1)) / 2;
    cur.x = Math.max(-mx, Math.min(mx, cur.x));
    cur.y = Math.max(-my, Math.min(my, cur.y));
  };
  const go = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(items.length - 1, i + d))), [items.length]);
  useEffect(() => {
    tf.current = { s: 1, x: 0, y: 0 };
    apply();
  }, [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: dist(a, b), s: tf.current.s };
      drag.current = null;
    } else if (pointers.current.size === 1) {
      const p = { x: e.clientX, y: e.clientY };
      drag.current = { start: p, last: p, moved: false };
    }
  };
  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      tf.current.s = Math.max(1, Math.min(MAX_SCALE, (pinch.current.s * dist(a, b)) / pinch.current.d));
      clamp();
      apply();
      return;
    }
    const d = drag.current;
    if (!d) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!d.moved && dist(d.start, p) > TAP_SLOP) d.moved = true;
    // At rest only the horizontal swipe moves the picture; zoomed, both axes pan.
    tf.current.x += p.x - d.last.x;
    if (tf.current.s > 1) tf.current.y += p.y - d.last.y;
    d.last = p;
    clamp();
    apply();
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      // One finger left on the glass keeps panning.
      const [p] = [...pointers.current.values()];
      if (p) drag.current = { start: p, last: p, moved: true };
      if (tf.current.s <= 1.02) {
        tf.current = { s: 1, x: 0, y: 0 };
        apply(true);
      }
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // A tap: twice in a row zooms in on the spot, or back out.
      const now = Date.now();
      if (now - lastTap.current >= DOUBLE_TAP_MS) {
        lastTap.current = now;
        return;
      }
      lastTap.current = 0;
      const r = stageRef.current?.getBoundingClientRect();
      if (tf.current.s > 1 || !r) tf.current = { s: 1, x: 0, y: 0 };
      else {
        const s = DOUBLE_TAP_SCALE;
        tf.current = { s, x: -(e.clientX - (r.left + r.width / 2)) * (s - 1), y: -(e.clientY - (r.top + r.height / 2)) * (s - 1) };
        clamp();
      }
      apply(true);
      return;
    }
    if (tf.current.s <= 1) {
      const dx = e.clientX - d.start.x;
      if (dx < -SWIPE_PX && index < items.length - 1) return go(1);
      if (dx > SWIPE_PX && index > 0) return go(-1);
      tf.current = { s: 1, x: 0, y: 0 };
      apply(true);
    }
  };

  const [busy, setBusy] = useState(false);
  const share = useMemo(canShareFiles, []);
  const name = nameOf(item.image);
  const fileName = (blob: Blob) => (/\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${(blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/\+.*/, "")}`);
  const act = async () => {
    if (!src || busy) return;
    setBusy(true);
    try {
      const blob = await blobOf(src);
      if (share && blob) {
        const file = new File([blob], fileName(blob), { type: blob.type || "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] }).catch(() => {});
          return;
        }
      }
      const a = document.createElement("a");
      a.href = blob ? URL.createObjectURL(blob) : src;
      a.download = blob ? fileName(blob) : name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="chat-viewer" role="dialog" aria-modal="true">
      <div className="chat-viewer-bar">
        <button type="button" className="chat-viewer-btn" aria-label={t("chatImgClose")} onClick={onClose}>
          {"✕"}
        </button>
        <span className="chat-viewer-name">{name}</span>
        {items.length > 1 && (
          <span className="chat-viewer-count">
            {index + 1} / {items.length}
          </span>
        )}
        <button type="button" className="chat-viewer-btn is-action" disabled={!src || busy} onClick={act}>
          {share ? t("chatImgShare") : t("chatImgSave")}
        </button>
      </div>
      <div className="chat-viewer-stage" ref={stageRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="chat-viewer-img" ref={imgRef}>
          {src ? <img src={src} alt={name} draggable={false} /> : <span className={"chat-viewer-state" + (state === "loading" ? " is-loading" : "")}>{state === "loading" ? "" : t("chatImgMissing")}</span>}
        </div>
      </div>
      {index > 0 && (
        <button type="button" className="chat-viewer-nav is-prev" aria-label={t("chatImgPrev")} onClick={() => go(-1)}>
          {"‹"}
        </button>
      )}
      {index < items.length - 1 && (
        <button type="button" className="chat-viewer-nav is-next" aria-label={t("chatImgNext")} onClick={() => go(1)}>
          {"›"}
        </button>
      )}
    </div>,
    document.body,
  );
}
