/** A serial queue for dictated phrases being cleaned up by a model: phrases are
 * delivered in the order they were pushed, one at a time; a failed (or empty)
 * cleanup delivers the raw phrase instead. */
export interface CleanupQueue {
  push(text: string): void;
  /** Phrases pushed and not yet delivered. */
  size(): number;
  /** Runs `cb` once the queue is empty (at once if it already is). */
  whenIdle(cb: () => void): void;
  /** Drops the callbacks waiting for the queue to empty; phrases still deliver. */
  cancelWaiters(): void;
  /** Disowns everything in flight: nothing more is delivered, waiters are dropped. */
  discard(): void;
}

export function createCleanupQueue(clean: (text: string) => Promise<string>, deliver: (text: string) => void): CleanupQueue {
  let generation = 0;
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  let waiters: Array<() => void> = [];

  const settle = () => {
    pending -= 1;
    if (pending > 0) return;
    const ready = waiters;
    waiters = [];
    ready.forEach((cb) => cb());
  };

  return {
    push(text) {
      const mine = generation;
      pending += 1;
      tail = tail
        .then(async () => {
          if (mine !== generation) return;
          let out = text;
          try {
            const cleaned = await clean(text);
            if (typeof cleaned === "string" && cleaned.trim()) out = cleaned;
          } catch {
            /* the raw phrase stays */
          }
          if (mine === generation) deliver(out);
        })
        .catch(() => {})
        .then(settle);
    },
    size: () => pending,
    whenIdle(cb) {
      if (pending === 0) cb();
      else waiters.push(cb);
    },
    cancelWaiters() {
      waiters = [];
    },
    discard() {
      generation += 1;
      waiters = [];
    },
  };
}
