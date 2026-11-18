import type { Dispatch, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppTab, TermTab } from "../tabs/types";
import { patchTermTab } from "../tabs/tabState";
import { expandHome, isAbsolutePath, isWindowsHostPath, isWindowsPlatform } from "../lib/path";
import { defaultWslDistro, toWindowsPath, wslHomeDir } from "./wslPath";
import { TITLE_HOST_PREFIX, cleanTitle, cmdTitlePathCandidates, firstExistingDir, looksLikeExecutablePath } from "./tabTitle";

type SetTabs = Dispatch<SetStateAction<AppTab[]>>;

/** Turns a WSL session's reported POSIX path into the Windows form the
 * explorer can browse (`\\wsl.localhost\...`, or a plain `C:\...` for the
 * distro's `/mnt` drive mounts - see `toWindowsPath`), and applies it to
 * the tab.
 *
 * Async because both halves may need looking up: the distro name (a bare
 * `wsl` with no `-d`) and the session's home dir (any `~`-shaped title,
 * i.e. the whole home tree - which is where `wsl` drops you, so it's the
 * normal case). Both lookups are memoized, so this costs one wsl.exe call
 * per distro+user for the whole app session. Crucially the path travels
 * *with* the lookup instead of the title update being dropped while one is
 * in flight: bash emits its title once per prompt, so a dropped update
 * would strand the explorer on the host path until the user happened to
 * run another command - which is what "the explorer disconnects the moment
 * I enter WSL" looked like. */
export async function applyWslTitle(setTabs: SetTabs, tabId: string, distro: string | undefined, user: string | undefined, path: string) {
  const resolvedDistro = distro || (await defaultWslDistro());
  if (!resolvedDistro) return;
  let posixPath = path;
  if (posixPath === "~" || posixPath.startsWith("~/")) {
    const home = await wslHomeDir(resolvedDistro, user);
    if (!home) return;
    posixPath = home + posixPath.slice(1);
  }
  if (!posixPath.startsWith("/")) return;
  const winPath = toWindowsPath(resolvedDistro, posixPath);
  setTabs((prev) =>
    patchTermTab(prev, tabId, (t) =>
      // Still the same WSL session? The user may have exited back to the
      // host shell (which clears `nestedShell`) while a lookup ran.
      t.nestedShell === "wsl" ? { cwd: winPath, explorerPath: winPath, wslDistro: resolvedDistro } : null,
    ),
  );
}

/** What a shell's reported title does to its tab: the patch to apply, and
 * any lookup that has to hit the filesystem first (applied when it
 * resolves). Pure - it only reads `t` - so the caller applies it with a
 * plain `setTabs`, and a title that changes nothing costs no render. */
export function resolveTitle(
  t: TermTab,
  rawTitle: string,
  homeDir: string,
  setTabs: SetTabs,
): { patch: Partial<TermTab>; after?: () => void } {
  const tabId = t.id;
  const trimmed = rawTitle.trim();
  const hostPrefix = trimmed.match(TITLE_HOST_PREFIX);
  const reportedUser = hostPrefix?.[1];
  const reportedPath = hostPrefix ? hostPrefix[2] : trimmed;
  const isWindows = isWindowsPlatform();
  const label = t.customLabel ? t.label : cleanTitle(trimmed);

  // `~` only expands against *this app's own host* home dir - correct
  // for a plain local shell, but meaningless for a nested WSL/remote
  // session's own (different, unknown to this app) home. Left
  // un-expanded there rather than turned into a bogus host path that
  // would wrongly look like "back on the host shell" and drop the
  // nested-shell tracking; a WSL tab's `~` is expanded further down
  // against the distro's own home instead, a remote's is dropped.
  const rawPath = t.nestedShell ? reportedPath : expandHome(reportedPath, homeDir);

  // A WSL shell collapses its home tree to `~` in the title it reports
  // (bash's `\w`), and `wsl` starts you right there - so unlike a host
  // shell's, a WSL tab's `~` can't be written off as "not a real cwd".
  // It's kept and expanded against the *distro's* home in
  // `applyWslTitle` below, where the lookup belongs.
  const isWslHomePath = t.nestedShell === "wsl" && (rawPath === "~" || rawPath.startsWith("~/"));
  if ((!isAbsolutePath(rawPath) && !isWslHomePath) || looksLikeExecutablePath(rawPath)) return { patch: { label } };

  // A genuine Windows path means we're back on a real host shell,
  // whatever nested session we might have been tracking before - but
  // only a title that names a directory that actually exists counts as
  // one, whenever there's a nested session to drop. Windows-shaped
  // console noise is emitted *during* a nested session too, and it
  // isn't distinguishable from a real post-exit prompt by shape alone
  // the way wsl/remote's POSIX titles are:
  //   - `"agent"` (Claude Code/Codex) reports a resolved script or
  //     shim path, or an OS default-title fallback, while it owns the
  //     screen;
  //   - cmd.exe retitles to "<cwd> - <command>" for the whole time a
  //     command runs, so typing `wsl` produces a title like
  //     `C:\...\flowcode - wsl` *before* the distro's own first title
  //     lands - taking that at face value dropped the WSL tracking
  //     that had just been set up, one keystroke into the session.
  // So the candidate is verified against the filesystem first, the
  // same deferred-update pattern as the wsl path translation below
  // (this title update itself is left alone; a confirmed candidate is
  // applied once the check resolves).
  if (isWindowsHostPath(rawPath)) {
    const nested = t.nestedShell;
    if (nested) {
      return {
        patch: { label },
        after: () => {
          void invoke<boolean>("is_directory", { path: rawPath })
            .catch(() => false)
            .then((isDir) => {
              if (!isDir) return;
              setTabs((prev) =>
                patchTermTab(prev, tabId, (t2) =>
                  // Still the same nested session? Anything that moved on
                  // since (exited, launched an agent) owns the tab now.
                  t2.nestedShell === nested
                    ? { cwd: rawPath, explorerPath: rawPath, nestedShell: undefined, wslDistro: undefined }
                    : null,
                ),
              );
            });
        },
      };
    }
    // "<cwd> - <command>" while a command runs in cmd.exe: taken at
    // face value it's a folder that doesn't exist - and whatever is
    // the cwd when the app closes is what session restore reopens.
    // Resolved against the filesystem instead (deferred, like above).
    if (rawPath.includes(" - ")) {
      const cwdBefore = t.cwd;
      return {
        patch: { label, nestedShell: undefined, wslDistro: undefined },
        after: () => {
          void firstExistingDir(cmdTitlePathCandidates(rawPath)).then((dir) => {
            if (!dir) return;
            setTabs((prev) =>
              patchTermTab(prev, tabId, (t2) =>
                // Unless a newer title already moved the tab on.
                !t2.nestedShell && t2.cwd === cwdBefore ? { cwd: dir, explorerPath: dir } : null,
              ),
            );
          });
        },
      };
    }
    return { patch: { cwd: rawPath, explorerPath: rawPath, label, nestedShell: undefined, wslDistro: undefined } };
  }

  // From here `rawPath` is POSIX-shaped.
  if (t.nestedShell === "remote" || t.nestedShell === "agent") {
    // ssh / docker exec (this app has no way to read that filesystem)
    // or Claude Code/Codex (a real filesystem, but not what a POSIX-
    // shaped title fragment while its own TUI owns the screen would
    // mean here) - cwd/explorerPath are left exactly where they were
    // rather than pointed at a local path that means nothing.
    return { patch: { label } };
  }
  if (t.nestedShell === "wsl" && isWindows) {
    // Deferred (see `applyWslTitle`) even when the distro is already
    // known, so every WSL title takes the same one path through the
    // `~`-expansion; the lookups behind it are memoized and the update
    // it applies is idempotent for a given title.
    return { patch: { label }, after: () => void applyWslTitle(setTabs, tabId, t.wslDistro, reportedUser, rawPath) };
  }

  // A plain POSIX path with no nested-shell context recognized - the
  // real local cwd (this app running on macOS/Linux, most commonly).
  return { patch: { cwd: rawPath, explorerPath: rawPath, label } };
}
