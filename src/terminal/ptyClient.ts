import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `PtyEvent` in src-tauri/src/pty.rs. */
type PtyEvent = { event: "output"; data: string; seq: number } | { event: "exit" };

export interface PtyHandlers {
  /** `seq` numbers each chunk in order - see `detachPty`. */
  onOutput: (data: string, seq: number) => void;
  onExit?: () => void;
}

export interface SpawnPtyOptions extends PtyHandlers {
  /** Empty/undefined means "no cwd" - the backend then inherits its own. */
  cwd?: string | null;
  cols: number;
  rows: number;
  /** A `list_shell_options` id; the configured default when omitted. */
  shell?: string;
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
export async function spawnPty({ cwd, cols, rows, shell, ...handlers }: SpawnPtyOptions): Promise<string> {
  const onEvent = eventChannel(handlers);
  return invoke<string>("pty_spawn", { cwd: cwd || null, cols, rows, shell: shell ?? null, onEvent });
}

/** Stops `id`'s output reaching this window - the first step of moving its
 * tab to another one. The program keeps running; what it prints meanwhile is
 * held for `attachPty`. Resolves to the `seq` of the last output already sent
 * here, so the caller can wait for it before snapshotting the screen. */
export function detachPty(id: string): Promise<number> {
  return invoke<number>("pty_detach", { id });
}

/** Takes over an existing (detached) session's output in this window,
 * starting with whatever it printed while detached. */
export function attachPty(id: string, handlers: PtyHandlers): Promise<void> {
  return invoke<void>("pty_attach", { id, onEvent: eventChannel(handlers) });
}

export function writePty(id: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { id, data }).catch(() => {});
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { id, cols, rows }).catch(() => {});
}

export function killPty(id: string): Promise<void> {
  return invoke<void>("pty_kill", { id }).catch(() => {});
}
