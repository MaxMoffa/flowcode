import { goalEnded, type ChatGoal, type ChatItem } from "./chatModel";

/** Elapsed time, short: `<1m`, `23m`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time for the panel header: `<1 min`, `23 min`, `1h 05m`. */
export function formatElapsedLong(ms: number): string {
  const short = formatElapsed(ms);
  return /^\d+m$/.test(short) || short === "<1m" ? short.replace("m", " min") : short;
}

/** How long the goal has run: since it was set while it goes, its final duration once ended; null when unknown. */
export function goalElapsedMs(goal: ChatGoal, now: number): number | null {
  if (goalEnded(goal) && goal.durationMs !== null) return goal.durationMs;
  if (goal.setAt === null) return null;
  return Math.max(0, now - goal.setAt);
}

/** Identifies one ended goal, so a dismissal sticks to it. */
export function goalKey(goal: ChatGoal): string {
  return `${goal.objective}\u0000${goal.status}\u0000${goal.setAt ?? ""}`;
}

/** Whether the chip shows: a live goal always; an ended one until dismissed or until the user writes after its marker. */
export function shouldShowGoal(goal: ChatGoal | null, items: ChatItem[], dismissedKey: string | null): boolean {
  if (!goal) return false;
  if (!goalEnded(goal)) return true;
  if (dismissedKey !== null && dismissedKey === goalKey(goal)) return false;
  let markerAt = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === "goal") {
      markerAt = i;
      break;
    }
  }
  if (markerAt < 0) return true;
  return !items.slice(markerAt + 1).some((i) => i.type === "user");
}
