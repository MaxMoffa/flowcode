import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { moveShortcut, SHORTCUT_HOLD_MS, useQuickActionReorder } from "./useQuickActionReorder";

const mock = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(value: T) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { mock.effects.push(effect); },
}));

let events: EventTarget;
let cleanup: (() => void) | undefined;
const ids = ["clearTerminal", "toggleAgentsSidebar", "browser"];

function mount() {
  const save = vi.fn();
  const hook = useQuickActionReorder(ids, save);
  cleanup = mock.effects[mock.effects.length - 1]() as () => void;
  let captured = false;
  const bar = {
    scrollLeft: 0,
    setPointerCapture: vi.fn(() => { captured = true; }),
    hasPointerCapture: () => captured,
    releasePointerCapture: vi.fn(() => { captured = false; }),
    getBoundingClientRect: () => ({ left: 0, right: 90 }),
    querySelectorAll: () => ids.map((id, index) => ({
      dataset: { shortcutId: id },
      getBoundingClientRect: () => ({ left: index * 30, width: 28 }),
    })),
  };
  const element = {
    parentElement: bar,
  };
  const down = (patch = {}) => hook.onPointerDown({
    currentTarget: element, button: 0, isPrimary: true, pointerId: 1, clientX: 14, clientY: 14,
    ...patch,
  } as unknown as ReactPointerEvent<HTMLDivElement>, ids[0]);
  const click = (detail = 1) => {
    const event = { detail, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    hook.onClickCapture(event as unknown as MouseEvent);
    return event;
  };
  return { save, bar, element: bar, down, click };
}

function emit(type: string, patch = {}, target?: unknown) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: "mouse", clientX: 74, clientY: 14 }, patch);
  if (target) Object.defineProperty(event, "target", { value: target });
  events.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.effects = [];
  events = new EventTarget();
  vi.stubGlobal("window", events);
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shortcut order", () => {
  it("moves in both directions without changing the input", () => {
    expect(moveShortcut(ids, ids[0], ids[2])).toEqual([ids[1], ids[2], ids[0]]);
    expect(moveShortcut(ids, ids[2], ids[0])).toEqual([ids[2], ids[0], ids[1]]);
    expect(ids).toEqual(["clearTerminal", "toggleAgentsSidebar", "browser"]);
  });
  it("keeps the same state for unchanged or missing shortcuts", () => {
    expect(moveShortcut(ids, ids[0], ids[0])).toBe(ids);
    expect(moveShortcut(ids, "deleted", ids[0])).toBe(ids);
    expect(moveShortcut(ids, ids[0], "deleted")).toBe(ids);
  });
});

describe("hold to reorder", () => {
  it("leaves short clicks alone", () => {
    const view = mount();
    view.down();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS - 1);
    emit("pointerup");
    vi.runAllTimers();
    expect(view.save).not.toHaveBeenCalled();
    expect(view.element.setPointerCapture).not.toHaveBeenCalled();
    expect(view.click().preventDefault).not.toHaveBeenCalled();
  });
  it("saves only on drop and suppresses the resulting click", () => {
    const view = mount();
    view.down();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointermove");
    expect(view.save).not.toHaveBeenCalled();
    emit("pointerup");
    expect(view.save).toHaveBeenCalledExactlyOnceWith(ids[0], ids[2]);
    expect(view.element.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(view.click().preventDefault).toHaveBeenCalled();
    expect(view.click(0).preventDefault).not.toHaveBeenCalled();
    view.down();
    expect(view.click().preventDefault).not.toHaveBeenCalled();
  });
  it.each(["pointercancel", "lostpointercapture", "blur", "keydown"])("discards the preview on %s", (type) => {
    const view = mount();
    view.down();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointermove");
    emit(type, { key: "Escape" }, type === "lostpointercapture" ? view.bar : undefined);
    emit("pointerup");
    expect(view.save).not.toHaveBeenCalled();
    expect(view.click().preventDefault).toHaveBeenCalled();
  });
  it("cancels a mouse hold when moving before activation", () => {
    const view = mount();
    view.down();
    emit("pointermove");
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointerup");
    expect(view.save).not.toHaveBeenCalled();
    expect(view.element.setPointerCapture).not.toHaveBeenCalled();
  });
  it("keeps dragging when implicit touch capture transfers from the button", () => {
    const view = mount();
    view.down();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("lostpointercapture", {}, { tagName: "BUTTON" });
    emit("pointermove", { pointerType: "touch" });
    emit("pointerup");
    expect(view.save).toHaveBeenCalledExactlyOnceWith(ids[0], ids[2]);
  });
  it("scrolls touch gestures before the hold without running the shortcut", () => {
    const view = mount();
    view.down();
    emit("pointermove", { pointerType: "touch", clientX: 4 });
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointerup");
    expect(view.bar.scrollLeft).toBe(10);
    expect(view.save).not.toHaveBeenCalled();
    expect(view.element.setPointerCapture).not.toHaveBeenCalled();
    expect(view.click().preventDefault).toHaveBeenCalled();
  });
  it("ignores secondary buttons and unrelated pointers", () => {
    const view = mount();
    view.down({ button: 2 });
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    expect(view.element.setPointerCapture).not.toHaveBeenCalled();
    view.down();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointermove", { pointerId: 2 });
    emit("pointerup", { pointerId: 2 });
    expect(view.save).not.toHaveBeenCalled();
    emit("pointermove");
    emit("pointerup");
    expect(view.save).toHaveBeenCalledWith(ids[0], ids[2]);
  });
  it("clears a pending hold when unmounting", () => {
    const view = mount();
    view.down();
    cleanup?.();
    vi.advanceTimersByTime(SHORTCUT_HOLD_MS);
    emit("pointerup");
    expect(view.save).not.toHaveBeenCalled();
    expect(view.element.setPointerCapture).not.toHaveBeenCalled();
  });
});
