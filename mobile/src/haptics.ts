import { invoke } from "@tauri-apps/api/core";

function fallback(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no vibrator */
  }
}

function fire(command: string, args: Record<string, unknown> | undefined, ms: number) {
  try {
    invoke(command, args).catch(() => fallback(ms));
  } catch {
    fallback(ms);
  }
}

/** Light tick for taps. Fire and forget: never throws, never blocks the click. */
export function tapFeedback(): void {
  fire("plugin:haptics|selection_feedback", undefined, 10);
}

/** Slightly firmer bump (modifier lock). */
export function lockFeedback(): void {
  fire("plugin:haptics|impact_feedback", { style: "medium" }, 12);
}
