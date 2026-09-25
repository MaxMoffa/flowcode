import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

export interface ShellOption {
  /** Sent back verbatim as `pty_spawn`'s `shell` argument. */
  id: string;
  label: string;
}

/** What to show for `opt`, in the current UI language - the backend's
 * labels are bare program names (see `list_shell_options` in pty.rs). */
export function shellOptionLabel(opt: ShellOption): string {
  if (opt.id === "system") return opt.label ? t("shell.defaultNamed", { name: opt.label }) : t("shell.default");
  if (opt.id === "cmd") return t("shell.cmd");
  return opt.label;
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
