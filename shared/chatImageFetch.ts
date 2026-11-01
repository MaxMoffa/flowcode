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
const MAX_PENDING = 32;
const MAX_RANGES = 4096;
const MAX_CACHE_ENTRIES = 256;

export interface ChatImageFetcherOptions {
  /** The peer echoes requestId as the response key. Older peers use the path/id/url. */
  supportsRequestIds?: () => boolean;
  /** Completed Blobs retained for reuse, in least-recently-used order. */
  maxCacheBytes?: number;
}

interface Cached {
  promise: Promise<Blob | null>;
  bytes: number;
  complete: boolean;
}

interface Pending {
  buf: Uint8Array | null;
  received: number;
  total: number | null;
  type: string | null;
  ranges: [number, number][];
  done: (blob: Blob | null, complete?: boolean) => void;
}

/** Loads images over one host's link. Paths are scoped to the chat that resolves
 * them. reset() ends a transport generation: call it after the old connection
 * can no longer deliver frames. dispose() also prevents new requests. */
export function createChatImageFetcher(
  send: (msg: { t: "chatimage"; chatId?: string; id?: string; path?: string; url?: string; requestId?: string }) => unknown,
  timeoutMs = 30_000,
  options: ChatImageFetcherOptions = {},
): { fetch(req: ChatImageRequest): Promise<Blob | null>; handle(msg: unknown): void; reset(): void; dispose(): void } {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Pending>();
  // A timeout on an old peer leaves no way to distinguish late chunks from
  // a retry. Do not reuse that key until its connection has been replaced.
  const uncertainLegacy = new Set<string>();
  const maxCacheBytes = Number.isFinite(options.maxCacheBytes) && options.maxCacheBytes! >= 0 ? options.maxCacheBytes! : MAX_IMAGE_BYTES;
  let cachedBytes = 0;
  let pendingBytes = 0;
  let disposed = false;
  let legacyBlocked = false;

  function trimCache() {
    for (const [key, entry] of cache) {
      if (cachedBytes <= maxCacheBytes && cache.size <= MAX_CACHE_ENTRIES) break;
      if (!entry.complete) continue;
      cache.delete(key);
      cachedBytes -= entry.bytes;
    }
  }

  function reset() {
    for (const item of [...pending.values()]) item.done(null);
    cache.clear();
    uncertainLegacy.clear();
    legacyBlocked = false;
    cachedBytes = 0;
  }

  return {
    fetch(req) {
      const target = req.id ? ["id", req.id] : req.path ? ["path", req.path] : req.url ? ["url", req.url] : null;
      if (disposed || !target) return Promise.resolve(null);
      const [kind, wireKey] = target;
      const key = JSON.stringify(kind === "path" ? [kind, req.chatId ?? "", wireKey] : [kind, wireKey]);
      const known = cache.get(key);
      if (known) {
        cache.delete(key);
        cache.set(key, known);
        return known.promise;
      }
      if (pending.size >= MAX_PENDING) return Promise.resolve(null);
      const requestId = options.supportsRequestIds?.() ? crypto.randomUUID() : undefined;
      const responseKey = requestId ?? wireKey;
      // Legacy responses cannot identify the chat. A concurrent collision is
      // refused without caching, so it can be retried after the first ends.
      if (!requestId && (legacyBlocked || pending.has(responseKey) || uncertainLegacy.has(responseKey))) return Promise.resolve(null);
      let resolve!: (blob: Blob | null) => void;
      const promise = new Promise<Blob | null>((done) => { resolve = done; });
      const entry: Cached = { promise, bytes: 0, complete: false };
      cache.set(key, entry);
      let settled = false;
      const timer = setTimeout(() => item.done(null), timeoutMs);
      const item: Pending = {
        buf: null, received: 0, total: null, type: null, ranges: [],
        done(blob, complete = false) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(responseKey);
          pendingBytes -= item.buf?.byteLength ?? 0;
          if (!requestId && !complete) {
            if (uncertainLegacy.size < MAX_CACHE_ENTRIES) uncertainLegacy.add(responseKey);
            else legacyBlocked = true;
          }
          if (blob && blob.size <= maxCacheBytes) {
            entry.complete = true;
            entry.bytes = blob.size;
            cachedBytes += blob.size;
            trimCache();
          } else {
            cache.delete(key);
          }
          resolve(blob);
        },
      };
      pending.set(responseKey, item);
      try {
        void Promise.resolve(send({ t: "chatimage", ...(req.chatId ? { chatId: req.chatId } : {}), ...(kind === "id" ? { id: wireKey } : kind === "path" ? { path: wireKey } : { url: wireKey }), ...(requestId ? { requestId } : {}) }))
          .then((ok) => { if (ok === false) item.done(null, true); }, () => item.done(null, true));
      } catch {
        item.done(null, true);
      }
      return promise;
    },
    handle(msg) {
      const m = msg as { t?: unknown; key?: unknown; offset?: unknown; total?: unknown; data?: unknown; mime?: unknown; missing?: unknown } | null;
      if (!m || m.t !== "chatimage" || typeof m.key !== "string") return;
      const p = pending.get(m.key);
      if (!p) return;
      const total = m.total;
      if (m.missing === true) return p.done(null, true);
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > MAX_IMAGE_BYTES) return p.done(null);
      const type = typeof m.mime === "string" && m.mime !== "" ? m.mime : "application/octet-stream";
      if ((p.total !== null && p.total !== total) || (p.type !== null && p.type !== type)) return p.done(null);
      p.total = total;
      p.type = type;
      if (total === 0) return m.offset === 0 && m.data === "" ? p.done(new Blob([], { type }), true) : p.done(null);
      if (typeof m.data !== "string" || typeof m.offset !== "number" || !Number.isSafeInteger(m.offset) || m.offset < 0) return p.done(null);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
      } catch {
        return p.done(null);
      }
      const offset = m.offset;
      const end = offset + bytes.length;
      if (bytes.length === 0 || end > total || p.ranges.length >= MAX_RANGES || p.ranges.some(([start, stop]) => offset < stop && end > start)) return p.done(null);
      if (!p.buf) {
        if (pendingBytes + total > MAX_IMAGE_BYTES) return p.done(null);
        p.buf = new Uint8Array(total);
        pendingBytes += total;
      }
      p.buf.set(bytes, m.offset);
      p.ranges.push([m.offset, end]);
      p.received += bytes.length;
      if (p.received === total) p.done(new Blob([p.buf as BlobPart], { type }), true);
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
