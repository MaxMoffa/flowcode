import { invoke } from "@tauri-apps/api/core";

export interface ShellOption {
  /** Sent back verbatim as `pty_spawn`'s `shell` argument. */
  id: string;
  label: string;
}

let cached: Promise<ShellOption[]> | null = null;

/** The shells offered on this OS/machine (see `list_shell_options` in
 * pty.rs). Memoized for the app session: building the list probes for WSL by
 * spawning `wsl.exe`, which the tab strip and Settings page would otherwise
 * each repeat. A failed lookup isn't cached, so it's retried next time. */
export function listShellOptions(): Promise<ShellOption[]> {
  if (!cached) {
    cached = invoke<ShellOption[]>("list_shell_options").catch(() => {
      cached = null;
      return [];
    });
  }
  return cached;
}
