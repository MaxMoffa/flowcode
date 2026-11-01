/** Object URLs shared by image consumers. A lease protects an image while it
 * is visible; unleased images are retained only within the LRU budget. */
interface ImageEntry {
  key: string;
  leases: number;
  promise: Promise<string | null> | null;
  cancel: (() => void) | null;
  src: string | null;
  size: number;
  fresh: boolean;
  expired: boolean;
  removed: boolean;
}

export interface ImageUrlCache {
  load(key: string, make: () => Promise<Blob | null>): Promise<string | null>;
  /** Retain before load, then release when the image is no longer visible. */
  retain(key: string): () => void;
  /** Forget inactive images now and active ones after their last lease. */
  clear(): void;
  /** Permanently release all images and invalidate in-flight loads. */
  dispose(): void;
  bytes(src: string): number | undefined;
}

export function createImageUrlCache(maxBytes = 64 * 1024 * 1024, maxEntries = 256): ImageUrlCache {
  const byteBudget = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 64 * 1024 * 1024;
  const entryBudget = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 256;
  const entries = new Map<string, ImageEntry>();
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  let disposed = false;
  let trimTimer: ReturnType<typeof setTimeout> | null = null;

  function entryFor(key: string): ImageEntry {
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, leases: 0, promise: null, cancel: null, src: null, size: 0, fresh: false, expired: false, removed: false };
    }
    // Map order is recency order, including a lookup of a cached promise.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function remove(entry: ImageEntry) {
    if (entry.removed) return;
    entry.removed = true;
    entries.delete(entry.key);
    entry.cancel?.();
    entry.cancel = null;
    if (entry.src) {
      URL.revokeObjectURL(entry.src);
      sizes.delete(entry.src);
      totalBytes -= entry.size;
    }
    if (entries.size === 0 && trimTimer !== null) {
      clearTimeout(trimTimer);
      trimTimer = null;
    }
  }

  function trim() {
    for (const entry of entries.values()) {
      if (entry.leases > 0 || entry.fresh) continue;
      if (entry.expired || (entry.promise === null && entry.src === null) || totalBytes > byteBudget || entries.size > entryBudget) remove(entry);
    }
  }

  function trimLater() {
    if (trimTimer !== null) return;
    // Resolving load() hands the URL to its consumers first. An unleased
    // image over budget must not be revoked before an awaiting consumer can
    // acquire a lease; synchronous trims also respect this grace period.
    trimTimer = setTimeout(() => {
      trimTimer = null;
      for (const entry of entries.values()) entry.fresh = false;
      trim();
    }, 0);
  }

  return {
    load(key, make) {
      if (disposed) return Promise.resolve(null);
      const entry = entryFor(key);
      if (entry.promise) return entry.promise;
      let resolve!: (src: string | null) => void;
      const promise = new Promise<string | null>((done) => { resolve = done; });
      entry.promise = promise;
      let settled = false;
      const finish = (blob: Blob | null) => {
        if (settled) return;
        settled = true;
        entry.cancel = null;
        if (disposed || entry.removed) {
          resolve(null);
          return;
        }
        if (blob) {
          try {
            entry.src = URL.createObjectURL(blob);
            entry.size = blob.size;
            entry.fresh = true;
            sizes.set(entry.src, blob.size);
            totalBytes += blob.size;
            resolve(entry.src);
            trimLater();
            return;
          } catch {
            // A failed URL allocation can be retried, like a failed fetch.
          }
        }
        entry.promise = null;
        if (entry.leases === 0) remove(entry);
        resolve(null);
      };
      entry.cancel = () => finish(null);
      try {
        void Promise.resolve(make()).then(finish, () => finish(null));
      } catch {
        finish(null);
      }
      return promise;
    },
    retain(key) {
      if (disposed) return () => {};
      const entry = entryFor(key);
      entry.leases++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.leases--;
        if (entry.removed) return;
        if (entry.leases === 0 && entry.expired) remove(entry);
        else trim();
      };
    },
    clear() {
      for (const entry of entries.values()) {
        if (entry.leases > 0) entry.expired = true;
        else remove(entry);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) remove(entry);
      if (trimTimer !== null) clearTimeout(trimTimer);
      trimTimer = null;
    },
    bytes: (src) => sizes.get(src),
  };
}
