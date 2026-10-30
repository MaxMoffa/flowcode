/** Fetches the images of a chat from the desktop over the remote link: one request per image, its `chatimage` chunks assembled into a Blob. Pure (no React). */

/** What to fetch: an image by the `id` the desktop stored it under, a file `path` on the chat's PC, or a web `url` (the desktop downloads it, if its user allowed). */
export interface ChatImageRequest {
  chatId?: string;
  id?: string;
  path?: string;
  url?: string;
}

/** Largest image accepted (bytes); a bigger `total` fails the fetch. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

interface Pending {
  buf: Uint8Array | null;
  received: number;
  done: (blob: Blob | null) => void;
}

/** A fetcher over `send` (the remote link's sender): `fetch` asks for an image once per key and caches it, `handle` takes the desktop's messages. A failed, missing or timed-out image is forgotten, so a later `fetch` retries it. */
export function createChatImageFetcher(
  send: (msg: { t: "chatimage"; chatId?: string; id?: string; path?: string; url?: string }) => unknown,
  timeoutMs = 30_000,
): { fetch(req: ChatImageRequest): Promise<Blob | null>; handle(msg: unknown): void } {
  const cache = new Map<string, Promise<Blob | null>>();
  const pending = new Map<string, Pending>();
  return {
    fetch(req) {
      const key = req.id ?? req.path ?? req.url;
      if (!key) return Promise.resolve(null);
      const known = cache.get(key);
      if (known) return known;
      const promise = new Promise<Blob | null>((resolve) => {
        const timer = setTimeout(() => finish(null), timeoutMs);
        const finish = (blob: Blob | null) => {
          clearTimeout(timer);
          pending.delete(key);
          if (!blob) cache.delete(key);
          resolve(blob);
        };
        pending.set(key, { buf: null, received: 0, done: finish });
      });
      cache.set(key, promise);
      send({ t: "chatimage", ...(req.chatId ? { chatId: req.chatId } : {}), ...(req.id ? { id: req.id } : req.path ? { path: req.path } : { url: req.url }) });
      return promise;
    },
    handle(msg) {
      const m = msg as { t?: unknown; key?: unknown; offset?: unknown; total?: unknown; data?: unknown; mime?: unknown; missing?: unknown } | null;
      if (!m || m.t !== "chatimage" || typeof m.key !== "string") return;
      const p = pending.get(m.key);
      if (!p) return;
      const total = m.total;
      if (m.missing === true || typeof total !== "number" || !Number.isInteger(total) || total < 0 || total > MAX_IMAGE_BYTES) return p.done(null);
      const type = typeof m.mime === "string" && m.mime !== "" ? m.mime : "application/octet-stream";
      if (total === 0) return p.done(new Blob([], { type }));
      if (typeof m.data !== "string" || typeof m.offset !== "number" || !Number.isInteger(m.offset) || m.offset < 0) return p.done(null);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
      } catch {
        return p.done(null);
      }
      if (m.offset + bytes.length > total) return p.done(null);
      p.buf ??= new Uint8Array(total);
      p.buf.set(bytes, m.offset);
      p.received += bytes.length;
      if (p.received >= total) p.done(new Blob([p.buf as BlobPart], { type }));
    },
  };
}
