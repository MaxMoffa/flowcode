import { invoke } from "@tauri-apps/api/core";

/** A fresh tab's label before its shell reports a title of its own - the
 * full path, same as what the shell's own title will show (tabs never
 * collapse the home dir to `~`). */
export function labelForCwd(cwd: string): string {
  return cwd || "shell";
}

/** Matches the "user@host: /some/path" shape most shells use for their OSC
 * title, capturing the user and the path. */
export const TITLE_HOST_PREFIX = /^([^\s@]+)@[^\s:]+:\s*(.+)$/;

/** Keeps just the useful part of a shell title - shown as the shell reports
 * it, full path included. */
export function cleanTitle(raw: string): string {
  const title = raw.trim();
  return title.match(TITLE_HOST_PREFIX)?.[2] ?? (title || "shell");
}

/** A cwd is never a file - but a brand new cmd.exe console on Windows starts
 * out titled with the full path to its OWN executable (e.g.
 * `C:\Windows\System32\cmd.exe`), before anything has set a real title. The
 * same thing happens launching Claude Code/Codex on Windows: if the shell
 * (or Windows console default-title fallback) reports the CLI's own script
 * path instead of a real title - an npm shim (`.cmd`/`.ps1`) or the Node
 * entry point itself (`.js`/`.mjs`/`.cjs`) - that also happens to pass
 * `isAbsolutePath`. Without this check a title update like that would stomp
 * `explorerPath` with the CLI's own script location instead of the actual
 * working directory, which then can't be `read_dir`'d (it's a file, not a
 * folder) and leaves the explorer pointed somewhere that looks "connected"
 * but shows nothing - and navigating up from there re-injects a `cd` into
 * whatever real session is still running in that shell. */
export function looksLikeExecutablePath(path: string): boolean {
  return /\.(exe|com|bat|cmd|ps1|js|mjs|cjs)$/i.test(path);
}

/** cmd.exe retitles to "<cwd> - <command>" for as long as a command runs, so
 * a title-derived Windows path may carry that suffix - and a folder name can
 * legitimately contain " - " too ("Foo - Copia"). Longest first: the path as
 * reported, then each shorter prefix cut at a " - ". */
export function cmdTitlePathCandidates(path: string): string[] {
  const candidates = [path];
  for (let i = path.lastIndexOf(" - "); i > 0; i = path.lastIndexOf(" - ", i - 1)) {
    candidates.push(path.slice(0, i));
  }
  return candidates;
}

/** The first of `candidates` that is an existing directory, if any. */
export async function firstExistingDir(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await invoke<boolean>("is_directory", { path: candidate }).catch(() => false)) return candidate;
  }
  return undefined;
}
