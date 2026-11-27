import { describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown[]>();
vi.mock("../lib/createListStore", () => ({
  createListStore: (key: string) => ({
    get: () => memory.get(key) ?? [],
    set: (next: unknown[]) => memory.set(key, next),
    subscribe: () => () => {},
  }),
}));

import { addFavorite, remoteFavorites } from "./favoritesStore";

describe("favorites per PC", () => {
  it("keeps each PC's list apart from the local one", () => {
    addFavorite("/local/a");
    remoteFavorites("h1").add("/srv/app", "wsl:Ubuntu");
    remoteFavorites("h2").add("C:\work");
    expect(remoteFavorites("h1").list()).toEqual([{ path: "/srv/app", name: "app", shell: "wsl:Ubuntu" }]);
    expect(remoteFavorites("h2").list().map((f) => f.path)).toEqual(["C:\work"]);
    expect(memory.get("flowcode.favorites")).toEqual([{ path: "/local/a", name: "a" }]);
    expect(memory.has("flowcode.remoteFavorites.h1")).toBe(true);
  });

  it("reuses one store per PC and de-dupes trailing separators", () => {
    const s = remoteFavorites("h3");
    expect(remoteFavorites("h3")).toBe(s);
    s.add("/x/y");
    s.add("/x/y/");
    expect(s.list()).toHaveLength(1);
    expect(s.isFavorite("/x/y/")).toBe(true);
    s.remove("/x/y/");
    expect(s.list()).toEqual([]);
  });
});
