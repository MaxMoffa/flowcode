import { describe, expect, it } from "vitest";
import type { ViewPackage } from "../../shared/remote-types";
import { runnableViews, syncViews, viewFits, viewLabel, type ViewCacheOps } from "./viewCache";

const pkg = (id: string, over: Partial<ViewPackage> = {}): ViewPackage => ({
  id,
  kind: "agentView",
  apiVersion: 1,
  label: id,
  entry: "index.html",
  transport: "acp",
  devices: ["phone"],
  permissions: ["send"],
  hash: `hash-${id}`,
  files: [{ path: "index.html", size: 10 }, { path: "app.js", size: 20 }],
  ...over,
});

/** A cache in memory plus a log of what was asked of it. */
function fakeOps(cached: string[] = [], fail: string[] = []) {
  const log: string[] = [];
  const have = new Set(cached);
  let running = 0;
  let peak = 0;
  const ops: ViewCacheOps = {
    has: async (id, hash) => have.has(`${id}/${hash}`),
    fetchFile: async (p, path) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (fail.includes(p.id)) throw new Error("timeout");
      log.push(`fetch ${p.id}/${path}`);
    },
    commit: async (id, hash, files) => {
      have.add(`${id}/${hash}`);
      log.push(`commit ${id} ${files.join(",")}`);
    },
    prune: async (keep) => void log.push(`prune ${keep.map((k) => k.id).join(",")}`),
  };
  return { ops, log, peak: () => peak };
}

describe("runnableViews", () => {
  it("keeps views for a phone or tablet at the bridge version this app speaks", () => {
    const list = [pkg("a"), pkg("b", { devices: ["desktop"] }), pkg("c", { devices: ["tablet", "desktop"] }), pkg("d", { apiVersion: 2 })];
    expect(runnableViews(list).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("fits a view to the screen: phone views on a phone, tablet views on a wide screen", () => {
    expect(viewFits(pkg("a"), false)).toBe(true);
    expect(viewFits(pkg("a"), true)).toBe(false);
    expect(viewFits(pkg("c", { devices: ["tablet"] }), true)).toBe(true);
  });

  it("names a view in the UI language, else its label", () => {
    const p = pkg("a", { label: "Timeline", labels: { it: "Cronologia" } });
    expect(viewLabel(p, "it")).toBe("Cronologia");
    expect(viewLabel(p, "en")).toBe("Timeline");
    expect(viewLabel(p, undefined)).toBe("Timeline");
  });
});

describe("syncViews", () => {
  it("downloads what is not cached, file by file, then commits and prunes", async () => {
    const { ops, log } = fakeOps();
    const ready: string[][] = [];
    await syncViews([pkg("a")], ops, (r) => ready.push(r.map((p) => p.id)));
    expect(log).toEqual(["fetch a/index.html", "fetch a/app.js", "commit a index.html,app.js", "prune a"]);
    expect(ready).toEqual([[], ["a"]]);
  });

  it("serves what is cached at once and downloads nothing for it", async () => {
    const { ops, log } = fakeOps(["a/hash-a"]);
    const ready: string[][] = [];
    await syncViews([pkg("a"), pkg("b")], ops, (r) => ready.push(r.map((p) => p.id)));
    expect(ready[0]).toEqual(["a"]);
    expect(ready[ready.length - 1]).toEqual(["a", "b"]);
    expect(log.filter((l) => l.startsWith("fetch")).every((l) => l.includes(" b/"))).toBe(true);
  });

  it("downloads again when the hash changed", async () => {
    const { ops, log } = fakeOps(["a/old-hash"]);
    await syncViews([pkg("a")], ops, () => {});
    expect(log.some((l) => l.startsWith("fetch a/"))).toBe(true);
  });

  it("downloads at most two packages at a time", async () => {
    const { ops, peak } = fakeOps();
    await syncViews([pkg("a"), pkg("b"), pkg("c"), pkg("d")], ops, () => {});
    expect(peak()).toBeLessThanOrEqual(2);
    expect(peak()).toBeGreaterThan(0);
  });

  it("keeps going after a failed package, reports the others, and does not prune", async () => {
    const { ops, log } = fakeOps([], ["b"]);
    const ready: string[][] = [];
    await syncViews([pkg("a"), pkg("b"), pkg("c")], ops, (r) => ready.push(r.map((p) => p.id)));
    expect([...ready[ready.length - 1]].sort()).toEqual(["a", "c"]);
    expect(log.some((l) => l.startsWith("commit b"))).toBe(false);
    expect(log.some((l) => l.startsWith("prune"))).toBe(false);
  });

  it("skips views that are not for this device and prunes the rest away", async () => {
    const { ops, log } = fakeOps();
    await syncViews([pkg("a", { devices: ["desktop"] })], ops, () => {});
    expect(log).toEqual(["prune "]);
  });
});
