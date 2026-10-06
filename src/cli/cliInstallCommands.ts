export type InstallableCli = "claude" | "codex" | "vibe";

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
 * alike, and from a headless `cmd /C` run.
 *
 * Mistral Vibe is a Python tool installed with uv (Mistral's documented
 * route). Unix: Mistral's own one-line installer, which brings uv along. On
 * Windows uv comes first when it's missing - its installer puts it in
 * `~\.local\bin` but can't add that to the PATH of the shell it runs in, so
 * that one call goes through the full path. Written without a single `$`:
 * typed into a PowerShell tab, the outer shell would expand any variable
 * inside the double quotes before the inner `powershell` ever saw it. */
export function cliInstallCommand(cli: InstallableCli, isWindows: boolean): string {
  if (cli === "codex") return "npm install -g @openai/codex";
  if (cli === "vibe") {
    return isWindows
      ? 'powershell -NoProfile -ExecutionPolicy ByPass -Command "if (Get-Command uv -ErrorAction SilentlyContinue) { uv tool install mistral-vibe } else { irm https://astral.sh/uv/install.ps1 | iex; Set-Location ~; .\\.local\\bin\\uv.exe tool install mistral-vibe }"'
      : "curl -LsSf https://mistral.ai/vibe/install.sh | bash";
  }
  return isWindows
    ? 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
    : "curl -fsSL https://claude.ai/install.sh | bash";
}
