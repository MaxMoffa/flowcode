// The images of a chat: fetched from the desktop over the remote link (by stored id or file path), kept as object urls for the session.
import { useEffect } from "react";
import type { ChatImageRef } from "../../src/chat/chatTypes";
import { createChatImageFetcher } from "../../shared/chatImageFetch";
import { onMessage, send, useRemoteSelector } from "./remote";
import { createStore } from "./store";

export type ChatImageState = "loading" | "ready" | "missing" | "blocked";

interface Entry {
  state: ChatImageState;
  src?: string;
}

const fetcher = createChatImageFetcher((msg) => send(msg as Parameters<typeof send>[0]));
onMessage((m) => fetcher.handle(m));

const store = createStore<{ entries: Record<string, Entry> }>({ entries: {} });
const setEntry = (key: string, entry: Entry) => store.set({ entries: { ...store.get().entries, [key]: entry } });

/** What an image is cached under; null for a ref with nothing to show. */
const keyOf = (ref: ChatImageRef, chatId?: string): string | null => (ref.id ? `id:${ref.id}` : ref.path ? `path:${chatId ?? ""}:${ref.path}` : ref.url ? `url:${ref.url}` : null);

/** An http(s) `url` ref: the desktop downloads it, and only if its user allowed web images. */
export const isWebImage = (ref: ChatImageRef) => !!ref.url && /^https?:\/\//i.test(ref.url);

const MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };
const mimeFromPath = (path?: string) => MIMES[(path?.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase()] ?? "image/png";

/** Asks the desktop for an image once; a missing one is asked again only by `retry`. */
function load(ref: ChatImageRef, chatId: string | undefined, retry = false) {
  const key = keyOf(ref, chatId);
  if (!key) return;
  const known = store.get().entries[key];
  if (known && !(retry && known.state === "missing")) return;
  setEntry(key, { state: "loading" });
  fetcher.fetch(ref.id ? { chatId, id: ref.id } : ref.path ? { chatId, path: ref.path } : { chatId, url: ref.url }).then((blob) => {
    if (!blob) return setEntry(key, { state: "missing" });
    setEntry(key, { state: "ready", src: URL.createObjectURL(new Blob([blob], { type: ref.mimeType ?? (blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeFromPath(ref.path ?? ref.url)) })) });
  });
}

/** Tries a missing image again (a link that dropped and came back). */
export const retryChatImage = (ref: ChatImageRef, chatId?: string) => load(ref, chatId, true);

/** The picture of an image ref: a `data:` url is used as is, an id or path is fetched from the desktop (missing when that desktop cannot send images), a web url too when the desktop allows web images (else blocked). */
export function useChatImage(ref: ChatImageRef, chatId?: string): { src: string | null; state: ChatImageState } {
  const web = isWebImage(ref);
  const supported = useRemoteSelector((s) => (web ? !!s.host?.caps.includes("chatWebImages") && s.settings?.chatWebImages === true : !!s.host?.caps.includes("chatImage")));
  const key = keyOf(ref, chatId);
  const entry = store.useSelector((s) => (key ? s.entries[key] : undefined));
  const wanted = (!ref.url || web) && key !== null && supported;
  useEffect(() => {
    if (wanted) load(ref, chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key, chatId]);
  if (ref.url && !web) return { src: ref.url, state: "ready" };
  if (!wanted) return { src: null, state: web ? "blocked" : "missing" };
  return { src: entry?.src ?? null, state: entry?.state ?? "loading" };
}
