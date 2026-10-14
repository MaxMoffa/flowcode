// Re-validates the configured terminal start folder: it may since have been
// deleted/unmounted, so it is checked rather than trusted outright.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** An invalid start path just falls back to home instead of handing pty_spawn
 * a cwd that no longer exists. `startPathChecked` is whether the check has
 * settled at least once - the startup tab waits on it, since `home_dir`
 * usually resolves first and would otherwise spawn the very first shell at
 * home before the configured start folder is known. */
export function useStartPath(startPath: string) {
  const [resolvedStartPath, setResolvedStartPath] = useState("");
  const [startPathChecked, setStartPathChecked] = useState(false);
  useEffect(() => {
    if (!startPath) {
      setResolvedStartPath("");
      setStartPathChecked(true);
      return;
    }
    let cancelled = false;
    invoke<boolean>("is_directory", { path: startPath })
      .then((ok) => {
        if (!cancelled) setResolvedStartPath(ok ? startPath : "");
      })
      .catch(() => {
        if (!cancelled) setResolvedStartPath("");
      })
      .finally(() => {
        if (!cancelled) setStartPathChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [startPath]);
  return { resolvedStartPath, startPathChecked };
}
