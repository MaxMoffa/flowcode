import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `PtyEvent` in src-tauri/src/pty.rs. */
type PtyEvent = { event: "output"; data: string; seq: number } | { event: "exit" };

interface PtyHandlers {
  /** `seq` numbers each chunk in order - see `detachPty`. */
  onOutput: (data: string, seq: number) => void;
  onExit?: () => void;
}

interface SpawnPtyOptions extends PtyHandlers {
  /** Empty/undefined means "no cwd" - the backend then inherits its own. */
  cwd?: string | null;
  cols: number;
  rows: number;
  /** A `list_shell_options` id; the configured default when omitted. */
  shell?: string;
  /** An account profile id (see src/profiles); the default profile when
   * omitted. The backend sets the CLIs' config-dir env vars from it. */
  profile?: string;
}

function eventChannel({ onOutput, onExit }: PtyHandlers): Channel<PtyEvent> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (message) => {
    if (message.event === "output") onOutput(message.data, message.seq);
    else onExit?.();
  };
  return channel;
}

/** Spawns a pty session and streams its output to `onOutput`.
 *
 * The output channel is created - and its handler attached - *before*
 * `pty_spawn` is even invoked, so nothing the shell prints first can be
 * missed. That matters beyond cosmetics: ConPTY's very first output is an
 * `ESC[6n` cursor-position query, and the session stalls until it gets an
 * answer (xterm produces one via `onData` - but only once it has been given
 * those bytes). A per-session channel also means each terminal receives only
 * its own session's output, instead of every tab filtering every other tab's
 * bytes off one global event. */
export async function spawnPty({ cwd, cols, rows, shell, profile, ...handlers }: SpawnPtyOptions): Promise<string> {
  const onEvent = eventChannel(handlers);
  return invoke<string>("pty_spawn", { cwd: cwd || null, cols, rows, shell: shell ?? null, profile: profile ?? null, onEvent });
}

/** Stops `id`'s output reaching this window - the first step of moving its
 * tab to another one. The program keeps running; what it prints meanwhile is
 * held for `attachPty`. Resolves to the `seq` of the last output already sent
 * here, so the caller can wait for it before snapshotting the screen. */
export async function detachPty(id: string): Promise<number> {
  // Input accepted by this window goes first, before its queue is forgotten
  // and the live session is handed to another window.
  for (let pending = writeQueues.get(id); pending; pending = writeQueues.get(id)) {
    const tail = pending.tail;
    await tail;
    if (pending.tail === tail) break;
  }
  return invoke<number>("pty_detach", { id });
}

/** Takes over an existing (detached) session's output in this window,
 * starting with whatever it printed while detached. */
export function attachPty(id: string, handlers: PtyHandlers): Promise<void> {
  return invoke<void>("pty_attach", { id, onEvent: eventChannel(handlers) });
}

/** Pty id -> when an Enter last went to it (ms). */
const submittedAt = new Map<string, number>();

/** Client-side memory budget, independent of the backend's 4 MiB write queue. */
export const MAX_PTY_QUEUED_BYTES = 8 * 1024 * 1024;
const WRITE_CHUNK_BYTES = 16 * 1024;
const BUSY_TIMEOUT_MS = 10_000;

export interface PtyWriteError {
  message: string;
  unsentBytes: number;
  kind: "overflow" | "busy" | "failed";
}

interface WriteQueue {
  tail: Promise<void>;
  /** Bytes retained by the queued strings, including a partly sent paste. */
  bytes: number;
  unsentBytes: number;
  cancelled: boolean;
  failed: boolean;
  stopped: Promise<void>;
  stop: () => void;
}

const writeQueues = new Map<string, WriteQueue>();
const writeErrors = new Map<string, Set<(error: PtyWriteError) => void>>();

/** UTF-8 size, including the replacement bytes used for a lone surrogate. */
export function ptyInputBytes(data: string): number {
  let bytes = 0;
  for (const char of data) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Splits on code point boundaries so an IPC chunk never breaks a surrogate pair. */
export function* ptyInputChunks(data: string, maxBytes = WRITE_CHUNK_BYTES): Generator<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError("PTY chunk budget must be at least 4 bytes");
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const char of data) {
    const point = char.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) {
      yield data.slice(start, end);
      start = end;
      bytes = 0;
    }
    end += char.length;
    bytes += size;
  }
  if (end > start) yield data.slice(start, end);
}

/** A terminal reports failures in its own output, including calls made by other UI components. */
export function onPtyWriteError(id: string, listener: (error: PtyWriteError) => void): () => void {
  let listeners = writeErrors.get(id);
  if (!listeners) writeErrors.set(id, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && writeErrors.get(id) === listeners) writeErrors.delete(id);
  };
}

function reportWriteError(id: string, error: PtyWriteError) {
  const listeners = writeErrors.get(id);
  if (!listeners?.size) {
    console.error(`PTY ${id}: ${error.message}; ${error.unsentBytes} bytes not sent`);
    return;
  }
  for (const listener of listeners) {
    try {
      listener(error);
    } catch (cause) {
      console.error("PTY write error listener failed", cause);
    }
  }
}

async function sendChunk(id: string, data: string, queue: WriteQueue): Promise<boolean> {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  let delay = 50;
  while (!queue.cancelled) {
    const result = await Promise.race([
      invoke<void>("pty_write", { id, data }).then(() => ({ sent: true } as const), (error: unknown) => ({ error } as const)),
      queue.stopped.then(() => ({ stopped: true } as const)),
    ]);
    if (queue.cancelled || "stopped" in result) return false;
    if ("sent" in result) return true;
    // Only this refusal guarantees the chunk was never queued. A different
    // error may be ambiguous, so replaying it could duplicate shell input.
    if (String(result.error) !== "pty busy") throw result.error;
    if (Date.now() >= deadline) throw new Error("pty busy");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, delay); }), queue.stopped]);
    } finally {
      clearTimeout(timer);
    }
    delay = Math.min(delay * 2, 250);
  }
  return false;
}

export function writePty(id: string, data: string): Promise<void> {
  if (!data) return Promise.resolve();
  const bytes = ptyInputBytes(data);
  let queue = writeQueues.get(id);
  if (queue?.failed) {
    reportWriteError(id, { kind: "failed", message: "PTY input queue stopped after a failed write", unsentBytes: bytes });
    return Promise.resolve();
  }
  if (bytes > MAX_PTY_QUEUED_BYTES || (queue?.bytes ?? 0) + bytes > MAX_PTY_QUEUED_BYTES) {
    reportWriteError(id, { kind: "overflow", message: "PTY input queue exceeds 8 MiB", unsentBytes: bytes });
    return Promise.resolve();
  }
  if (!queue) {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    queue = { tail: Promise.resolve(), bytes: 0, unsentBytes: 0, cancelled: false, failed: false, stopped, stop };
    writeQueues.set(id, queue);
  }
  const pending = queue;
  pending.bytes += bytes;
  pending.unsentBytes += bytes;
  pending.tail = pending.tail.then(async () => {
    if (pending.cancelled || pending.failed) return;
    for (const chunk of ptyInputChunks(data)) {
      if (!(await sendChunk(id, chunk, pending))) return;
      pending.unsentBytes -= ptyInputBytes(chunk);
      if (chunk.includes("\r")) submittedAt.set(id, Date.now());
    }
  }).catch((error: unknown) => {
    if (pending.cancelled) return;
    pending.failed = true;
    const message = error instanceof Error ? error.message : String(error);
    reportWriteError(id, { kind: message === "pty busy" ? "busy" : "failed", message, unsentBytes: pending.unsentBytes });
  }).finally(() => {
    pending.bytes -= bytes;
    if (pending.bytes === 0) {
      pending.stop();
      if (writeQueues.get(id) === pending) writeQueues.delete(id);
    }
  });
  return pending.tail;
}

/** Drops the bookkeeping for a pty that is gone, so the map doesn't grow
 * with every session ever opened. */
export function forgetPty(id: string): void {
  const pending = writeQueues.get(id);
  if (pending) {
    pending.cancelled = true;
    pending.stop();
    writeQueues.delete(id);
  }
  writeErrors.delete(id);
  submittedAt.delete(id);
}

/** When the pty last got an Enter - a prompt sent to the agent running in
 * it, as far as the outside can tell. 0 if never. */
export function lastSubmitAt(id: string | null | undefined): number {
  return (id && submittedAt.get(id)) || 0;
}

/** An Enter a phone sent straight to the pty (it never goes through `writePty`). */
export function noteRemoteSubmit(id: string): void {
  submittedAt.set(id, Date.now());
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { id, cols, rows }).catch(() => {});
}

export function killPty(id: string): Promise<void> {
  forgetPty(id);
  return invoke<void>("pty_kill", { id }).catch(() => {});
}
