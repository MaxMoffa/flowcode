export type InstallableCli = "claude" | "codex";

/** The actual command line that installs a given CLI - shared by the in-app
 * "this CLI isn't installed yet" prompt (App.tsx's `checkCliAndMaybeLaunch`)
 * and the standalone installer flow, so there's exactly one trusted command
 * per CLI instead of two copies that could quietly drift apart.
 *
 * Claude's official install command is written for PowerShell (`irm ... |
 * iex` - Invoke-RestMethod/Invoke-Expression, PowerShell-only aliases). This
 * app's terminal tabs default to PowerShell (see pty.rs's `default_shell`),
 * but a tab can still be cmd.exe (picked in Settings), and cmd.exe has no
 * `irm`/`iex` of its own to fall back on - typed there as-is, it just fails
 * with "'irm' is not recognized". Wrapping it in an explicit
 * `powershell -Command "..."` call works from a PowerShell or cmd.exe prompt
 * alike, and from a headless `cmd /C` run. */
export function cliInstallCommand(cli: InstallableCli, isWindows: boolean): string {
  if (cli === "codex") return "npm install -g @openai/codex";
  return isWindows
    ? 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
    : "curl -fsSL https://claude.ai/install.sh | bash";
}
