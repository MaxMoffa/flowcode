import { useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { basename } from "../lib/path";
import { PathIcons } from "../lib/fileLinks";
import { MenuIcons } from "../context-menu/menuIcons";
import { useOpenLink } from "../terminal/useOpenLink";
import { ChatImageSource, imageBytes, useChatImage } from "./chatImages";
import type { ChatImageRef } from "./chatTypes";

/** The image each [data-chat-img] element of the conversation shows, for the lightbox to browse them all. */
const registry = new WeakMap<Element, ChatImageRef>();

/** A ref callback that records the image on its element. */
const register = (image: ChatImageRef) => (el: Element | null) => {
  if (el) registry.set(el, image);
};

/** The name to show for an image. */
const nameOf = (image: ChatImageRef, fallback: string) => image.name ?? (image.path ? basename(image.path) : fallback);

/** Draws the image on a canvas and puts it on the clipboard as a PNG. */
async function copyImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

type Point = { clientX: number; clientY: number; ctrlKey?: boolean; shiftKey?: boolean };

/** What can be done with an image: copy it, open it (with the default app, or the web link through the app's link path) and show it in its folder (only images on this PC). Each is null when it doesn't apply. */
function useImageActions(image: ChatImageRef, src: string | null) {
  const { local, chatId } = useContext(ChatImageSource);
  const openLink = useOpenLink();
  const stored = local && (!!image.id || !!image.path);
  const web = image.url && /^https?:\/\//i.test(image.url) ? image.url : null;
  const filePath = () => invoke<string>("chat_image_path", image.id ? { id: image.id } : { chatId, path: image.path });
  return {
    copy: src ? () => void copyImage(src).catch(() => {}) : null,
    open: stored
      ? () => void filePath().then((path) => invoke("open_with_default_app", { path })).catch(() => {})
      : web
        ? (e: Point) => openLink(e, web)
        : null,
    reveal: stored ? () => void filePath().then((path) => revealItemInDir(path)).catch(() => {}) : null,
  };
}

/** The host of a web address (the address itself when it doesn't parse). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const MISSING_ICON = (
  <svg className="chat-img-missing-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 18 5-5 4 4 2.5-2.5L20 18" />
  </svg>
);

/** A small button over an image; a span (the image is a button itself, and buttons don't nest). */
function ImageAction({ title, onAct, children }: { title: string; onAct: (e: Point) => void; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="chat-img-btn"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onAct(e);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onAct({ clientX: 0, clientY: 0 });
      }}
    >
      {children}
    </span>
  );
}

/** One image of a chat: its bytes load on demand (a shimmer meanwhile, a card when it is gone); a click opens the lightbox on every image of the conversation. `single` is the full-size one (with hover actions), `thumb` a user's attachment, `cell` a square of a grid (`more` hidden images behind it, as "+N"). */
export function ChatImageView({ image, variant, caption, more }: { image: ChatImageRef; variant: "single" | "thumb" | "cell"; caption?: string; more?: number }) {
  const { t } = useI18n();
  const { src, state, onError, loadOnce } = useChatImage(image);
  const actions = useImageActions(image, src);
  const [lightbox, setLightbox] = useState<{ items: ChatImageRef[]; at: number } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeLightbox = useCallback(() => {
    setLightbox(null);
    opener.current?.focus();
  }, []);
  const name = nameOf(image, t("chat.image.alt"));
  const cls = `chat-img is-${variant}`;
  if (state === "loading") return <span className={`${cls} is-loading`} aria-busy="true" />;
  if (state === "missing") {
    return (
      <span className={`${cls} is-missing`} title={name}>
        {MISSING_ICON}
        <span>
          <span className="chat-img-missing-name">{name}</span>
          <br />
          {t("chat.image.missing")}
        </span>
      </span>
    );
  }
  if (state === "blocked") {
    const url = image.url ?? "";
    return (
      <span className={`${cls} is-blocked`} title={url}>
        {MISSING_ICON}
        <span>
          <span className="chat-img-missing-name">{hostOf(url)}</span>
          <br />
          {t("chat.image.blocked")}
          <br />
          <span className="chat-img-blocked-hint">{t("chat.image.blockedHint")}</span>
          {loadOnce && (
            <button type="button" className="chat-img-load" title={url} onClick={loadOnce}>
              {t("chat.image.load")}
            </button>
          )}
        </span>
      </span>
    );
  }
  const openLightbox = () => {
    const button = opener.current;
    if (!button) return;
    const scope = button.closest(".chat-content") ?? button.parentElement ?? button;
    const nodes = [...scope.querySelectorAll("[data-chat-img]")];
    const items = nodes.map((n) => registry.get(n)).filter((r): r is ChatImageRef => !!r);
    const at = nodes.indexOf(button);
    setLightbox(at >= 0 && items.length === nodes.length ? { items, at } : { items: [image], at: 0 });
  };
  return (
    <>
      <button
        type="button"
        ref={(el) => {
          opener.current = el;
          register(image)(el);
        }}
        data-chat-img=""
        className={cls}
        title={name}
        onClick={openLightbox}
      >
        <img src={src ?? undefined} alt={caption ?? name} draggable={false} onError={onError} />
        {more ? <span className="chat-img-more">{t("chat.image.more", { count: more })}</span> : null}
        {variant === "single" && (actions.copy || actions.open || actions.reveal) && (
          <span className="chat-img-actions">
            {actions.open && (
              <ImageAction title={t("chat.image.open")} onAct={actions.open}>
                {MenuIcons.openExternal}
              </ImageAction>
            )}
            {actions.copy && (
              <ImageAction title={t("chat.image.copy")} onAct={actions.copy}>
                {PathIcons.copy}
              </ImageAction>
            )}
            {actions.reveal && (
              <ImageAction title={t("chat.image.reveal")} onAct={actions.reveal}>
                {PathIcons.folder}
              </ImageAction>
            )}
          </span>
        )}
      </button>
      {caption && variant === "single" && <span className="chat-img-cap">{caption}</span>}
      {lightbox && (
        <ChatLightbox
          items={lightbox.items}
          start={lightbox.at}
          onClose={closeLightbox}
        />
      )}
    </>
  );
}

/** Images of one message: one alone at its size, several as a grid of squares (four at most, the last with "+N" for the rest, which stay in the lightbox's reach). `thumb` draws a user's attachments. */
export function ChatImages({ images, variant = "single" }: { images: ChatImageRef[]; variant?: "single" | "thumb" }) {
  if (images.length === 0) return null;
  if (variant === "thumb") {
    return (
      <div className="chat-user-images">
        {images.map((image, i) => (
          <ChatImageView key={i} image={image} variant="thumb" />
        ))}
      </div>
    );
  }
  if (images.length === 1) return <ChatImageView image={images[0]} variant="single" />;
  const shown = images.slice(0, 4);
  const hidden = images.slice(4);
  return (
    <div className="chat-img-grid">
      {shown.map((image, i) => (
        <ChatImageView key={i} image={image} variant="cell" more={i === 3 && hidden.length > 0 ? hidden.length : undefined} />
      ))}
      {hidden.map((image, i) => (
        <span key={`h${i}`} hidden data-chat-img="" ref={register(image)} />
      ))}
    </div>
  );
}

/** "12 KB", "1.4 MB". */
function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The images of the conversation full screen: arrows browse, Esc or a click outside closes. */
function ChatLightbox({ items, start, onClose }: { items: ChatImageRef[]; start: number; onClose: () => void }) {
  const { t } = useI18n();
  const [at, setAt] = useState(start);
  const image = items[at];
  const { src, state, onError } = useChatImage(image);
  const actions = useImageActions(image, src);
  const [dims, setDims] = useState<{ src: string; w: number; h: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const step = useCallback((d: number) => setAt((i) => (i + d + items.length) % items.length), [items.length]);
  useEffect(() => {
    root.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      const used = e.key === "Escape" || (items.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight"));
      if (!used) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") onClose();
      else step(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items.length, onClose, step]);
  const name = nameOf(image, t("chat.image.alt"));
  const bytes = src ? imageBytes(src) : undefined;
  const size = dims && dims.src === src ? `${dims.w}×${dims.h}` : "";
  const meta = [size, bytes !== undefined ? formatBytes(bytes) : ""].filter(Boolean).join(" · ");
  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.image.lightbox")}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="chat-lightbox-bar">
        <span className="chat-lightbox-name">{name}</span>
        {meta && <span>{"· "}{meta}</span>}
        <span className="chat-lightbox-spacer" />
        {actions.copy && (
          <button type="button" title={t("chat.image.copy")} onClick={actions.copy}>
            {PathIcons.copy}
            {t("chat.image.copy")}
          </button>
        )}
        {actions.open && (
          <button type="button" title={t("chat.image.open")} onClick={(e) => actions.open?.(e)}>
            {MenuIcons.openExternal}
            {t("chat.image.open")}
          </button>
        )}
        {actions.reveal && (
          <button type="button" title={t("chat.image.reveal")} onClick={actions.reveal}>
            {PathIcons.folder}
            {t("chat.image.reveal")}
          </button>
        )}
        <button type="button" title={t("chat.image.close")} aria-label={t("chat.image.close")} onClick={onClose}>
          {"✕"}
        </button>
      </div>
      <div className="chat-lightbox-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {items.length > 1 && (
          <button type="button" className="chat-lightbox-nav is-prev" title={t("chat.image.prev")} aria-label={t("chat.image.prev")} onClick={() => step(-1)}>
            {"‹"}
          </button>
        )}
        {state === "ready" && src ? (
          <img
            key={src}
            src={src}
            alt={name}
            draggable={false}
            onLoad={(e) => setDims({ src, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={onError}
          />
        ) : state === "missing" ? (
          <div className="chat-lightbox-gone">{t("chat.image.missing")}</div>
        ) : (
          <span className="chat-spinner" aria-hidden="true" />
        )}
        {items.length > 1 && (
          <button type="button" className="chat-lightbox-nav is-next" title={t("chat.image.next")} aria-label={t("chat.image.next")} onClick={() => step(1)}>
            {"›"}
          </button>
        )}
        {items.length > 1 && <span className="chat-lightbox-count">{at + 1} / {items.length}</span>}
      </div>
    </div>,
    document.body,
  );
}
