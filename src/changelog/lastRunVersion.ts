import { readString, writeString } from "../lib/storage";
import { hasSeenWelcome } from "../welcome/welcomeSeen";

/** The Flowcode version that last ran - how a launch tells it's the first
 * one after an update. */
const LAST_RUN_VERSION_KEY = "flowcode.lastRunVersion";

/** Records `current` as the version that last ran, and reports whether this
 * launch is the first since Flowcode was updated to it. Recorded right away,
 * so the "What's new" tab opens once per update: closed, it stays closed
 * until the next one. With nothing recorded yet it's either a fresh install
 * (nothing to announce) or an update from a build predating this key - told
 * apart by whether the welcome tour was already seen. */
export function consumeUpdatedVersion(current: string): boolean {
  const previous = readString(LAST_RUN_VERSION_KEY);
  if (previous === current) return false;
  writeString(LAST_RUN_VERSION_KEY, current);
  return previous !== null || hasSeenWelcome();
}
