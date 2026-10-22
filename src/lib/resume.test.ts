import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onResume, SLEEP_GAP_MS } from "./resume";

describe("onResume", () => {
  let visibility: (() => void) | undefined;
  const doc = { hidden: false, addEventListener: (_: string, fn: () => void) => (visibility = fn), removeEventListener: () => (visibility = undefined) };

  beforeEach(() => {
    vi.useFakeTimers();
    doc.hidden = false;
    vi.stubGlobal("document", doc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires when the page becomes visible, not when it hides", () => {
    const fn = vi.fn();
    const off = onResume(fn);
    doc.hidden = true;
    visibility?.();
    expect(fn).not.toHaveBeenCalled();
    doc.hidden = false;
    visibility?.();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    expect(visibility).toBeUndefined();
  });

  it("fires when the heartbeat finds the page was asleep, but not on a normal beat", () => {
    const fn = vi.fn();
    const off = onResume(fn);
    vi.advanceTimersByTime(20000);
    expect(fn).not.toHaveBeenCalled();
    // The clock jumps while no timer runs, like a machine sleeping.
    vi.setSystemTime(Date.now() + SLEEP_GAP_MS * 2);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
