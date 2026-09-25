import { invoke } from "@tauri-apps/api/core";

/** What is at the front of a terminal tab, as the OS reports it - see
 * `pty_foreground` in src-tauri/src/pty.rs. */
export interface Foreground {
  kind: "cmd" | "powershell" | "posix" | "fish" | "nu" | "wsl" | "remote" | "program";
  program: string;
  wsl_distro: string | null;
}

/** Shells whose syntax this app can write a command in. */
export type ShellKind = Extract<Foreground["kind"], "cmd" | "powershell" | "posix" | "fish" | "nu">;

/** `null` when the pty is gone or the lookup failed - callers must then not
 * type anything, rather than guess. */
export async function ptyForeground(ptyId: string | null | undefined): Promise<Foreground | null> {
  if (!ptyId) return null;
  return invoke<Foreground>("pty_foreground", { id: ptyId }).catch(() => null);
}

/** A shell (local, WSL or remote) is waiting at its prompt - typing a
 * command there runs it. `program` means something else owns the input. */
export function atShellPrompt(fg: Foreground | null): boolean {
  return !!fg && fg.kind !== "program";
}

function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Hooks that make each shell report its cwd as the terminal title on every
 * prompt - what the tab label and the explorer follow. The spawned cmd.exe /
 * PowerShell already have them (pty.rs's `pty_spawn`); re-sent with each
 * explorer `cd` so a shell started *inside* a tab gets them too, which then
 * makes its hand-typed `cd`s followed as well. Idempotent. */
const PS_TITLE_PROMPT =
  "if (-not $global:__flowcodePrompt) { $global:__flowcodePrompt = $function:prompt; " +
  "function global:prompt { ([char]27 + ']0;' + (Get-Location).Path + [char]7) + ((& $global:__flowcodePrompt) -join '') } }";
const CMD_TITLE_PROMPT = "prompt $E]0;$P$E\\$P$G";

/** PowerShell ends a single-quoted string on any of these, not just the
 * ASCII `'` - and Windows allows the curly ones in folder names. Each is
 * escaped by doubling it, like `''`. */
const PS_SINGLE_QUOTES = /['‘’‚‛]/g;

/** C0/C1 controls (CR/LF, ESC, CSI...): the command is typed straight into
 * the pty, so one of these in a name could submit it early or drive the
 * terminal. No shell's quoting covers that - such a path is refused. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** The explorer's `cd`, in the syntax of the shell at the prompt, or `null`
 * when `path` can't be written safely in it (the caller then types nothing).
 * The path is a folder name on disk - a cloned repo or an unpacked archive
 * picks it - so this quoting is all that keeps a click from running
 * arbitrary commands. Each form also retitles the terminal with the new cwd
 * right away: that's the signal the silent navigation waits for to erase the
 * typed line, and what moves the tab label / explorer along with it.
 *   - cmd: `/d` to follow a folder onto another drive; a path can't contain
 *     `"`, so plain double quotes are safe.
 *   - PowerShell: no `/d`, no `&&` in 5.1; `-LiteralPath` + single quotes,
 *     so `[`, `$` and `` ` `` in a name are literal; every single-quote
 *     variant doubled (see PS_SINGLE_QUOTES).
 *   - POSIX shells: single quotes with `'\''`; `--` so a name starting with
 *     `-` isn't an option; `printf` with octal escapes (dash has no `\e`).
 *   - fish: same quoting, its own `printf` escapes.
 *   - nu: raw single-quoted string - a `'` in the path needs nu's
 *     backtick form instead, and a path with both has no safe form. */
export function cdCommand(path: string, kind: ShellKind): string | null {
  if (CONTROL_CHARS.test(path)) return null;
  switch (kind) {
    case "cmd":
      return `cd /d "${path}" && ${CMD_TITLE_PROMPT}`;
    case "powershell":
      return `Set-Location -LiteralPath '${path.replace(PS_SINGLE_QUOTES, "$&$&")}'; ${PS_TITLE_PROMPT}`;
    case "posix":
      return `cd -- ${posixQuote(path)} && printf '\\033]0;%s\\007' "$PWD"`;
    case "fish":
      return `cd ${posixQuote(path)}; and printf '\\e]0;%s\\a' $PWD`;
    case "nu": {
      if (path.includes("'") && path.includes("`")) return null;
      const quoted = path.includes("'") ? `\`${path}\`` : `'${path}'`;
      return `cd ${quoted}; print -n $"\\e]0;($env.PWD)\\a"`;
    }
  }
}
