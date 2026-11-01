import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createImageUrlCache } from "../../shared/imageUrlCache";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useHost } from "../remoteHosts/remoteHosts";
import { retainRemoteImageLoader, type RemoteImageLoaderLease } from "./remoteImageLoader";
import type { ChatImageRef } from "./chatTypes";

/** How a chat's images are loaded: `load` gives an object URL (a `data:` ref as it is, null when the image is gone); `web` is whether http(s) `url` refs may load at all (else the image is "blocked"); `loadOnce` (this PC only) loads one web image despite that; `local` is whether the chat runs on this PC (its images can be opened and shown in a folder). */
export interface ChatImageSourceValue {
  load(ref: ChatImageRef): Promise<string | null>;
  web: boolean;
  retain?(ref: ChatImageRef): () => void;
  cacheKey?(ref: ChatImageRef): string | null;
  loadOnce?(ref: ChatImageRef): Promise<string | null>;
  local: boolean;
  chatId: string | null;
}

/** An http(s) `url` ref: the app's CSP keeps it out of an <img>, so it is fetched by the backend (when allowed). */
const isWeb = (ref: ChatImageRef) => !!ref.url && /^https?:\/\//i.test(ref.url);

/** Without a provider only `data:` refs show. */
const NONE: ChatImageSourceValue = { load: (ref) => Promise.resolve(ref.url && !isWeb(ref) ? ref.url : null), web: false, local: false, chatId: null };

export const ChatImageSource = createContext<ChatImageSourceValue>(NONE);

const urls = createImageUrlCache();
export const imageBytes = urls.bytes;

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };

/** The type of an image: the ref's own, else by the extension of its path or name, else PNG. */
function mimeOf(ref: ChatImageRef, fallback?: string): string {
  if (ref.mimeType) return ref.mimeType;
  if (fallback && fallback !== "application/octet-stream") return fallback;
  const ext = (ref.path ?? ref.name ?? ref.url ?? "").replace(/[?#].*$/, "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "image/png";
}

/** IDs identify content; relative paths belong to one chat and host. */
const keyOf = (ref: ChatImageRef, chatId: string | null) => (ref.id ? `id:${ref.id}` : ref.path ? `path:${chatId ?? ""}:${ref.path}` : ref.url ? `url:${ref.url}` : null);
const cacheKey = (scope: string, ref: ChatImageRef, chatId: string | null) => {
  const key = keyOf(ref, chatId);
  return key ? `${scope}:${key}` : null;
};
const retain = (key: string | null) => key ? urls.retain(key) : () => {};

/** Loads the images of a chat running on this PC. */
export function LocalChatImageProvider({ chatId, children }: { chatId: string | null; children: ReactNode }) {
  const { chatWebImages } = useTerminalSettings();
  const loadOnce = useCallback(
    (ref: ChatImageRef) => {
      if (ref.url && !isWeb(ref)) return Promise.resolve(ref.url);
      const key = cacheKey("local", ref, chatId);
      if (!key) return Promise.resolve(null);
      return urls.load(key, async () => {
        const data = await (ref.id
          ? invoke<ArrayBuffer>("chat_image", { id: ref.id })
          : ref.path
            ? invoke<ArrayBuffer>("chat_image_file", { chatId, path: ref.path })
            : invoke<ArrayBuffer>("chat_image_url", { url: ref.url }));
        const blob = new Blob([Array.isArray(data) ? Uint8Array.from(data) : data]);
        return new Blob([blob], { type: mimeOf(ref, blob.type) });
      });
    },
    [chatId],
  );
  const load = useCallback((ref: ChatImageRef) => (isWeb(ref) && !chatWebImages ? Promise.resolve(null) : loadOnce(ref)), [loadOnce, chatWebImages]);
  const value = useMemo(() => ({ load, loadOnce, web: chatWebImages, local: true, chatId,
    cacheKey: (ref: ChatImageRef) => cacheKey("local", ref, chatId),
    retain: (ref: ChatImageRef) => retain(cacheKey("local", ref, chatId)),
  }), [load, loadOnce, chatWebImages, chatId]);
  return <ChatImageSource.Provider value={value}>{children}</ChatImageSource.Provider>;
}

/** Providers share a host's transport; URL reuse has one bounded app-wide budget. */
export function RemoteChatImageProvider({ hostId, chatId, children }: { hostId: string; chatId: string; children: ReactNode }) {
  const host = useHost(hostId);
  const supported = !!host?.caps.includes("chatImage");
  const web = !!host?.caps.includes("chatWebImages");
  const requestIds = !!host?.caps.includes("chatImageRequestId");
  const online = host?.status === "online";
  const fetcher = useRef<RemoteImageLoaderLease["fetcher"] | null>(null);
  useLayoutEffect(() => {
    if (!online) return;
    const current = retainRemoteImageLoader(hostId, requestIds);
    fetcher.current = current.fetcher;
    return () => { current.release(); if (fetcher.current === current.fetcher) fetcher.current = null; };
  }, [hostId, online, requestIds]);
  const value = useMemo<ChatImageSourceValue>(() => {
    const scope = `remote:${hostId}`;
    const load = (ref: ChatImageRef) => {
      if (ref.url && !isWeb(ref)) return Promise.resolve(ref.url);
      const key = cacheKey(scope, ref, chatId);
      if (!key || !(ref.url ? web : supported)) return Promise.resolve(null);
      return urls.load(key, async () => {
        const blob = await fetcher.current?.fetch(ref.id ? { chatId, id: ref.id } : ref.path ? { chatId, path: ref.path } : { chatId, url: ref.url });
        return blob ? new Blob([blob], { type: mimeOf(ref, blob.type) }) : null;
      });
    };
    return { load, web, local: false, chatId,
      cacheKey: (ref) => cacheKey(scope, ref, chatId),
      retain: (ref) => retain(cacheKey(scope, ref, chatId)),
    };
  }, [hostId, chatId, supported, web, online, requestIds]);
  return <ChatImageSource.Provider value={value}>{children}</ChatImageSource.Provider>;
}

/** An image to draw: `loading` until its bytes came, `missing` when they are gone or the browser can't draw them (`onError` of the <img>), `blocked` for a web image that may not load (`loadOnce`, on this PC, loads just this one). */
export function useChatImage(ref: ChatImageRef): { src: string | null; state: "loading" | "ready" | "missing" | "blocked"; onError: () => void; loadOnce: (() => void) | null } {
  const source = useContext(ChatImageSource);
  const key = source.cacheKey ? source.cacheKey(ref) : keyOf(ref, source.chatId);
  const [result, setResult] = useState<{ key: string | null; src: string | null; failed: boolean } | null>(null);
  const [forced, setForced] = useState<string | null>(null);
  const blocked = isWeb(ref) && !source.web && forced !== key;
  useEffect(() => {
    if (blocked) return;
    let live = true;
    const release = source.retain?.(ref);
    void (forced === key && source.loadOnce ? source.loadOnce(ref) : source.load(ref)).then((src) => live && setResult({ key, src, failed: !src }));
    return () => {
      live = false;
      release?.();
    };
    // `ref` is identified by its key; the item behind it keeps its identity or changes the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source.load, blocked]);
  const onError = useCallback(() => setResult({ key, src: null, failed: true }), [key]);
  const loadOnce = source.loadOnce && isWeb(ref) ? () => setForced(key) : null;
  if (!key) return { src: null, state: "missing", onError, loadOnce: null };
  if (blocked) return { src: null, state: "blocked", onError, loadOnce };
  const mine = result?.key === key ? result : null;
  if (ref.url && !isWeb(ref)) return mine?.failed ? { src: null, state: "missing", onError, loadOnce: null } : { src: ref.url, state: "ready", onError, loadOnce: null };
  if (!mine) return { src: null, state: "loading", onError, loadOnce: null };
  return mine.failed ? { src: null, state: "missing", onError, loadOnce: null } : { src: mine.src, state: "ready", onError, loadOnce: null };
}
