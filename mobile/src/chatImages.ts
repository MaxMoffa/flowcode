// Image ownership follows mounted consumers; inactive URLs and Blobs have bounded budgets.
import { useEffect, useState } from "react";
import type { ChatImageRef } from "../../src/chat/chatTypes";
import { createChatImageFetcher } from "../../shared/chatImageFetch";
import { createImageUrlCache } from "../../shared/imageUrlCache";
import { onMessage, sendChecked, useRemoteSelector } from "./remote";
import { createStore } from "./store";

export type ChatImageState = "loading" | "ready" | "missing" | "blocked";
let supportsRequestIds = false;
const urls = createImageUrlCache();
const changes = createStore({ generation: 0, retry: 0 });
const fetcher = createChatImageFetcher((msg) => sendChecked(msg), 30_000, { supportsRequestIds: () => supportsRequestIds });
onMessage((message) => {
  if (message.t === "ready") {
    supportsRequestIds = !!message.caps?.includes("chatImageRequestId");
    fetcher.reset();
    urls.clear();
    changes.set({ generation: changes.get().generation + 1, retry: 0 });
  } else fetcher.handle(message);
});

const keyOf = (ref: ChatImageRef, chatId?: string) => ref.id ? `id:${ref.id}` : ref.path ? `path:${chatId ?? ""}:${ref.path}` : ref.url ? `url:${ref.url}` : null;
const isWebImage = (ref: ChatImageRef) => !!ref.url && /^https?:\/\//i.test(ref.url);
const MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };
const mimeFromPath = (path?: string) => MIMES[(path?.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase()] ?? "image/png";

/** Missing loads are not cached: a revision lets mounted consumers try again. */
export function retryChatImage(_ref: ChatImageRef, _chatId?: string) {
  changes.set({ ...changes.get(), retry: changes.get().retry + 1 });
}

export function useChatImage(ref: ChatImageRef, chatId?: string): { src: string | null; state: ChatImageState } {
  const web = isWebImage(ref);
  const supported = useRemoteSelector((s) => web ? !!s.host?.caps.includes("chatWebImages") && s.settings?.chatWebImages === true : !!s.host?.caps.includes("chatImage"));
  const revision = changes.useSelector((s) => s);
  const rawKey = keyOf(ref, chatId);
  const key = rawKey ? `${revision.generation}:${rawKey}` : null;
  const wanted = (!ref.url || web) && key !== null && supported;
  const [entry, setEntry] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!wanted || !key) return;
    let live = true;
    const release = urls.retain(key);
    void urls.load(key, async () => {
      const blob = await fetcher.fetch(ref.id ? { chatId, id: ref.id } : ref.path ? { chatId, path: ref.path } : { chatId, url: ref.url });
      return blob ? new Blob([blob], { type: ref.mimeType ?? (blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeFromPath(ref.path ?? ref.url)) }) : null;
    }).then((src) => { if (live) setEntry({ key, src }); });
    return () => { live = false; release(); };
    // The key identifies the immutable image ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key, revision.retry]);
  if (ref.url && !web) return { src: ref.url, state: "ready" };
  if (!wanted) return { src: null, state: web ? "blocked" : "missing" };
  if (!entry || entry.key !== key) return { src: null, state: "loading" };
  return { src: entry.src, state: entry.src ? "ready" : "missing" };
}
