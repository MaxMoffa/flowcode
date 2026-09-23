import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `PtyEvent` in src-tauri/src/pty.rs. */
type PtyEvent = { event: "output"; data: string } | { event: "exit" };

export interface SpawnPtyOptions {
  /** Empty/undefined means "no cwd" - the backend then inherits its own. */
  cwd?: string | null;
  cols: number;
  rows: number;
  /** A `list_shell_options` id; the configured default when omitted. */
  shell?: string;
  onOutput: (data: string) => void;
  onExit?: () => void;
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
export async function spawnPty({ cwd, cols, rows, shell, onOutput, onExit }: SpawnPtyOptions): Promise<string> {
  const onEvent = new Channel<PtyEvent>();
  onEvent.onmessage = (message) => {
    if (message.event === "output") onOutput(message.data);
    else onExit?.();
  };
  return invoke<string>("pty_spawn", { cwd: cwd || null, cols, rows, shell: shell ?? null, onEvent });
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
