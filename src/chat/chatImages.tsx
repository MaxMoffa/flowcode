import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createChatImageFetcher } from "../../shared/chatImageFetch";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { onHostMessages, sendToHost, useHost } from "../remoteHosts/remoteHosts";
import type { ChatImageRef } from "./chatTypes";

/** How a chat's images are loaded: `load` gives an object URL (a `data:` ref as it is, null when the image is gone); `web` is whether http(s) `url` refs may load at all (else the image is "blocked"); `loadOnce` (this PC only) loads one web image despite that; `local` is whether the chat runs on this PC (its images can be opened and shown in a folder). */
export interface ChatImageSourceValue {
  load(ref: ChatImageRef): Promise<string | null>;
  web: boolean;
  loadOnce?(ref: ChatImageRef): Promise<string | null>;
  local: boolean;
  chatId: string | null;
}

/** An http(s) `url` ref: the app's CSP keeps it out of an <img>, so it is fetched by the backend (when allowed). */
const isWeb = (ref: ChatImageRef) => !!ref.url && /^https?:\/\//i.test(ref.url);

/** Without a provider only `data:` refs show. */
const NONE: ChatImageSourceValue = { load: (ref) => Promise.resolve(ref.url && !isWeb(ref) ? ref.url : null), web: false, local: false, chatId: null };

export const ChatImageSource = createContext<ChatImageSourceValue>(NONE);

/** Byte size of each object URL made here, for the lightbox. */
const sizes = new Map<string, number>();
/** Bytes of the image behind an object URL made here, when known. */
export const imageBytes = (src: string): number | undefined => sizes.get(src);

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };

/** The type of an image: the ref's own, else by the extension of its path or name, else PNG. */
function mimeOf(ref: ChatImageRef, fallback?: string): string {
  if (ref.mimeType) return ref.mimeType;
  if (fallback && fallback !== "application/octet-stream") return fallback;
  const ext = (ref.path ?? ref.name ?? ref.url ?? "").replace(/[?#].*$/, "").split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "image/png";
}

/** An object URL for the bytes (an ArrayBuffer, or the plain array a webview may hand over). */
function objectUrl(data: ArrayBuffer | number[] | Blob, ref: ChatImageRef): string {
  const blob = data instanceof Blob ? data : new Blob([Array.isArray(data) ? Uint8Array.from(data) : data]);
  const url = URL.createObjectURL(new Blob([blob], { type: mimeOf(ref, blob.type) }));
  sizes.set(url, blob.size);
  return url;
}

/** The key one image is cached under (an id is global, a path is the chat's). */
const keyOf = (ref: ChatImageRef, chatId: string | null) => (ref.id ? `id:${ref.id}` : ref.path ? `path:${chatId ?? ""}:${ref.path}` : ref.url ? `url:${ref.url}` : null);

/** A cache of object URLs by key: a failed load is forgotten, so a later one retries. Never revoked (images are few and small). */
function cached(cache: Map<string, Promise<string | null>>, key: string, make: () => Promise<string | null>): Promise<string | null> {
  const known = cache.get(key);
  if (known) return known;
  const promise = make().catch(() => null);
  cache.set(key, promise);
  void promise.then((url) => url ?? cache.delete(key));
  return promise;
}

const localCache = new Map<string, Promise<string | null>>();

/** Loads the images of a chat running on this PC. */
export function LocalChatImageProvider({ chatId, children }: { chatId: string | null; children: ReactNode }) {
  const { chatWebImages } = useTerminalSettings();
  const loadOnce = useCallback(
    (ref: ChatImageRef) => {
      if (ref.url && !isWeb(ref)) return Promise.resolve(ref.url);
      const key = keyOf(ref, chatId);
      if (!key) return Promise.resolve(null);
      return cached(localCache, key, async () => {
        const data = await (ref.id
          ? invoke<ArrayBuffer>("chat_image", { id: ref.id })
          : ref.path
            ? invoke<ArrayBuffer>("chat_image_file", { chatId, path: ref.path })
            : invoke<ArrayBuffer>("chat_image_url", { url: ref.url }));
        return objectUrl(data, ref);
      });
    },
    [chatId],
  );
  const load = useCallback((ref: ChatImageRef) => (isWeb(ref) && !chatWebImages ? Promise.resolve(null) : loadOnce(ref)), [loadOnce, chatWebImages]);
  const value = useMemo(() => ({ load, loadOnce, web: chatWebImages, local: true, chatId }), [load, loadOnce, chatWebImages, chatId]);
  return <ChatImageSource.Provider value={value}>{children}</ChatImageSource.Provider>;
}

interface RemoteLoader {
  fetcher: ReturnType<typeof createChatImageFetcher>;
  urls: Map<string, Promise<string | null>>;
}
const remoteLoaders = new Map<string, RemoteLoader>();

/** One fetcher per host, fed by the host's messages (subscribed once for the app's life). */
function remoteLoader(hostId: string): RemoteLoader {
  let loader = remoteLoaders.get(hostId);
  if (!loader) {
    const fetcher = createChatImageFetcher((msg) => sendToHost(hostId, msg));
    onHostMessages(hostId, (msgs) => msgs.forEach((m) => fetcher.handle(m)));
    remoteLoaders.set(hostId, (loader = { fetcher, urls: new Map() }));
  }
  return loader;
}

/** Loads the images of a chat of another PC over the remote link. */
export function RemoteChatImageProvider({ hostId, chatId, children }: { hostId: string; chatId: string; children: ReactNode }) {
  const caps = useHost(hostId)?.caps;
  const supported = !!caps?.includes("chatImage");
  const web = !!caps?.includes("chatWebImages");
  const value = useMemo<ChatImageSourceValue>(() => {
    const load = (ref: ChatImageRef) => {
      if (ref.url && !isWeb(ref)) return Promise.resolve(ref.url);
      const key = keyOf(ref, chatId);
      if (!key || !(ref.url ? web : supported)) return Promise.resolve(null);
      const { fetcher, urls } = remoteLoader(hostId);
      return cached(urls, key, async () => {
        const blob = await fetcher.fetch(ref.id ? { chatId, id: ref.id } : ref.path ? { chatId, path: ref.path } : { chatId, url: ref.url });
        return blob ? objectUrl(blob, ref) : null;
      });
    };
    return { load, web, local: false, chatId };
  }, [hostId, chatId, supported, web]);
  return <ChatImageSource.Provider value={value}>{children}</ChatImageSource.Provider>;
}

/** An image to draw: `loading` until its bytes came, `missing` when they are gone or the browser can't draw them (`onError` of the <img>), `blocked` for a web image that may not load (`loadOnce`, on this PC, loads just this one). */
export function useChatImage(ref: ChatImageRef): { src: string | null; state: "loading" | "ready" | "missing" | "blocked"; onError: () => void; loadOnce: (() => void) | null } {
  const source = useContext(ChatImageSource);
  const key = keyOf(ref, source.chatId);
  const [result, setResult] = useState<{ key: string | null; src: string | null; failed: boolean } | null>(null);
  const [forced, setForced] = useState<string | null>(null);
  const blocked = isWeb(ref) && !source.web && forced !== key;
  useEffect(() => {
    if (blocked) return;
    let live = true;
    void (forced === key && source.loadOnce ? source.loadOnce(ref) : source.load(ref)).then((src) => live && setResult({ key, src, failed: !src }));
    return () => {
      live = false;
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
