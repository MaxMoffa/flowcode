import { describe, expect, it } from "vitest";
import { nextDone } from "./doneTabs";

const prev = (o: Record<string, string | undefined>) => new Map(Object.entries(o));

describe("nextDone", () => {
  it("marks a hidden tab that stopped working", () => {
    expect([...nextDone(prev({ a: "busy" }), [{ key: "a", status: "idle" }], "b", new Set())]).toEqual(["a"]);
    expect([...nextDone(prev({ a: "waiting" }), [{ key: "a", status: "idle" }], null, new Set())]).toEqual(["a"]);
  });
  it("ignores the shown tab and tabs still working", () => {
    expect(nextDone(prev({ a: "busy" }), [{ key: "a", status: "idle" }], "a", new Set()).size).toBe(0);
    expect(nextDone(prev({ a: "busy" }), [{ key: "a", status: "waiting" }], "b", new Set()).size).toBe(0);
  });
  it("clears a tab when shown or gone", () => {
    const done = new Set(["a", "b"]);
    expect([...nextDone(prev({}), [{ key: "a", status: "idle" }], "a", done)]).toEqual([]);
  });
  it("keeps earlier marks", () => {
    expect([...nextDone(prev({}), [{ key: "a", status: "idle" }, { key: "b" }], null, new Set(["a"]))]).toEqual(["a"]);
  });
});
