import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { mock.effects.push(effect); },
}));

let events: EventTarget;
let pending: (() => void)[];
let position: number;
let back: ReturnType<typeof vi.fn>;
let hook: typeof import("./back").useBackHandler;

const mount = (callback = vi.fn()) => {
  hook(true, callback);
  return { close: mock.effects[mock.effects.length - 1]() as () => void, callback };
};
const settle = () => { while (pending.length) pending.shift()!(); };

beforeEach(async () => {
  vi.resetModules();
  mock.effects = [];
  events = new EventTarget();
  pending = [];
  position = 0;
  back = vi.fn(() => pending.push(() => { position--; events.dispatchEvent(new Event("popstate")); }));
  vi.stubGlobal("window", events);
  vi.stubGlobal("history", { pushState: () => { position++; }, back });
  hook = (await import("./back")).useBackHandler;
});
afterEach(() => vi.unstubAllGlobals());

describe("overlay history", () => {
  it("opens the Browser from a closing menu without popping the Browser's new entry", () => {
    const menu = mount();
    menu.close();
    const browser = mount();
    settle();
    expect(position).toBe(1);
    browser.close();
    settle();
    expect(position).toBe(0);
  });
  it("tolerates StrictMode mounting, cleaning up and mounting again", () => {
    mount().close();
    const browser = mount();
    settle();
    expect(position).toBe(1);
    browser.close();
    settle();
    expect(position).toBe(0);
  });
  it("serializes cleanup backs for multiple layers", () => {
    const first = mount();
    const second = mount();
    second.close();
    first.close();
    expect(back).toHaveBeenCalledTimes(1);
    settle();
    expect(back).toHaveBeenCalledTimes(2);
    expect(position).toBe(0);
  });
  it("a system Back closes only the top layer and causes no cleanup Back", () => {
    const first = mount();
    const second = mount();
    position--;
    events.dispatchEvent(new Event("popstate"));
    expect(second.callback).toHaveBeenCalledOnce();
    expect(first.callback).not.toHaveBeenCalled();
    second.close();
    expect(back).not.toHaveBeenCalled();
    first.close();
    settle();
    expect(position).toBe(0);
  });
  it("drops an overlay closed before its pending history entry was pushed", () => {
    mount().close();
    mount().close();
    settle();
    expect(position).toBe(0);
    expect(back).toHaveBeenCalledTimes(1);
  });
});
