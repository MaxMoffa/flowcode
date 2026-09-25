import { invoke } from "@tauri-apps/api/core";

let needsNoDaemon: Promise<boolean> | null = null;

/** Whether Codex has to be started with `--no-daemon` from this app - true
 * only when the Windows Job Object Flowcode runs in forbids breakaway, which
 * Codex needs for its shared background server (see `codex_needs_no_daemon`
 * in src-tauri/src/plugins.rs). Asked once per app run: the answer can't
 * change while the process lives. A failed check isn't cached, and counts as
 * "no" - the plain launch is what ran before this check existed. */
export function codexNeedsNoDaemon(): Promise<boolean> {
  if (!needsNoDaemon) {
    needsNoDaemon = invoke<boolean>("codex_needs_no_daemon").catch(() => {
      needsNoDaemon = null;
      return false;
    });
  }
  return needsNoDaemon;
}

/** `command` with `--no-daemon` appended when it launches Codex and the host
 * needs it - at the end, so it works for a bare `codex` as well as for
 * `codex resume <id>` (the flag is accepted in both positions). */
export async function withCodexLaunchFlags(command: string): Promise<string> {
  if (!/^codex(\.exe)?(?:\s|$)/i.test(command.trim()) || /--no-daemon/.test(command)) return command;
  return (await codexNeedsNoDaemon()) ? `${command.trim()} --no-daemon` : command;
}
