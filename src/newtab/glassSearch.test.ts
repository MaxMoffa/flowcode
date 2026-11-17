import { describe, expect, it } from "vitest";
import { completePath, groupByKind, kindsShown, matchingSubfolders, mergeFolders, nextFilter, parsePathQuery, rootsLabel, searchRoots, splitMatch, typedFolder } from "./glassSearch";

const win = { home: "C:\\Users\\massi", base: "C:\\work", windows: true };
const posix = { home: "/home/massi", base: null, windows: false };

describe("filters", () => {
  it("cycles both ways and wraps", () => {
    expect(nextFilter("all", 1)).toBe("folders");
    expect(nextFilter("recents", 1)).toBe("all");
    expect(nextFilter("all", -1)).toBe("recents");
  });
  it("Cartelle lets favorites and found folders through", () => {
    expect([...kindsShown("folders")]).toEqual(["favorite", "folder"]);
    expect([...kindsShown("agents")]).toEqual(["agent"]);
    expect(kindsShown("all").has("shell")).toBe(true);
    expect(kindsShown("folders").has("shell")).toBe(false);
  });
  it("groups results by section keeping each one's order", () => {
    const items = [
      { kind: "folder", id: 1 },
      { kind: "agent", id: 2 },
      { kind: "recent", id: 3 },
      { kind: "folder", id: 4 },
      { kind: "agent", id: 5 },
    ] as const;
    expect(groupByKind(items).map((i) => i.id)).toEqual([2, 5, 3, 1, 4]);
  });
});

describe("searchRoots", () => {
  it("skips a root inside another and duplicates", () => {
    const roots = searchRoots(["C:\\Users\\massi\\Docs\\Progetti", "D:\\code", "d:\\CODE\\", "D:\\code\\sub"], "C:\\Users\\massi");
    expect(roots.map((r) => r.path)).toEqual(["D:\\code", "C:\\Users\\massi"]);
    expect(roots[1].home).toBe(true);
  });
  it("is not fooled by a shared name prefix", () => {
    expect(searchRoots(["/srv/app", "/srv/app2"], null).map((r) => r.path)).toEqual(["/srv/app", "/srv/app2"]);
  });
  it("keeps favorites alone when the home is unknown", () => {
    expect(searchRoots(["/a"], null)).toEqual([{ path: "/a", home: false }]);
  });
  it("names the roots by folder, the home as Home", () => {
    expect(rootsLabel(searchRoots(["D:\\code\\Progetti"], "C:\\Users\\massi"), "Home")).toBe("Progetti, Home");
  });
});

describe("mergeFolders", () => {
  const f = (path: string) => ({ name: path.split(/[\\/]/).filter(Boolean).pop()!, path });
  it("drops known and repeated folders, best name match first, and limits", () => {
    const lists = [[f("C:\\a\\my-flow"), f("C:\\a\\flow"), f("C:\\a\\known-flow")], [f("c:\\a\\FLOW\\"), f("C:\\b\\flowery")]];
    const out = mergeFolders(lists, "flow", ["C:\\a\\known-flow"], 3);
    expect(out.map((e) => e.path)).toEqual(["C:\\a\\flow", "C:\\b\\flowery", "C:\\a\\my-flow"]);
    expect(mergeFolders(lists, "flow", [], 1)).toHaveLength(1);
  });
});

describe("splitMatch", () => {
  it("cuts around the match, ignoring case", () => {
    expect(splitMatch("FlowCode", "wco")).toEqual({ before: "Flo", match: "wCo", after: "de" });
    expect(splitMatch("flowcode", "xyz")).toBeNull();
    expect(splitMatch("flowcode", " ")).toBeNull();
  });
});

describe("parsePathQuery", () => {
  it("reads a drive path", () => {
    expect(parsePathQuery("C:\\Users\\ma", win)).toEqual({ dir: "C:\\Users\\", readPath: "C:\\Users\\", segment: "ma", explicit: true });
    expect(parsePathQuery("C:\\", win)).toMatchObject({ dir: "C:\\", segment: "" });
  });
  it("reads a WSL UNC path", () => {
    expect(parsePathQuery("\\\\wsl$\\Ubuntu\\home\\x", win)).toMatchObject({ dir: "\\\\wsl$\\Ubuntu\\home\\", segment: "x", explicit: true });
  });
  it("expands ~ to the home with the home's separators", () => {
    expect(parsePathQuery("~/Doc", win)).toEqual({ dir: "~/", readPath: "C:\\Users\\massi\\", segment: "Doc", explicit: true });
    expect(parsePathQuery("~/a/b", posix)).toMatchObject({ dir: "~/a/", readPath: "/home/massi/a/", segment: "b" });
    expect(parsePathQuery("~/a", { ...win, home: null })).toBeNull();
  });
  it("takes a leading / as a path off Windows only", () => {
    expect(parsePathQuery("/usr/lo", posix)).toMatchObject({ readPath: "/usr/", segment: "lo", explicit: true });
    expect(parsePathQuery("/usr/lo", win)).toBeNull();
  });
  it("resolves a relative path against the base, then the home - not explicit", () => {
    expect(parsePathQuery("src\\ne", win)).toEqual({ dir: "src\\", readPath: "C:\\work\\src\\", segment: "ne", explicit: false });
    expect(parsePathQuery("src/ne", { ...win, base: null })).toMatchObject({ readPath: "C:\\Users\\massi\\src\\" });
  });
  it("is null without a separator", () => {
    expect(parsePathQuery("flow", win)).toBeNull();
    expect(parsePathQuery("C:", win)).toBeNull();
  });
});

describe("path completion", () => {
  const pq = parsePathQuery("~/Do", win)!;
  const entries = [
    { name: "Desktop", is_dir: true },
    { name: "Documents", is_dir: true },
    { name: "docs.txt", is_dir: false },
    { name: "Downloads", is_dir: true },
  ];
  it("lists the subfolders the typed name starts", () => {
    expect(matchingSubfolders(entries, pq.segment).map((e) => e.name)).toEqual(["Documents", "Downloads"]);
    expect(matchingSubfolders(entries, "")).toHaveLength(3);
  });
  it("completes into the typed form, with a separator", () => {
    expect(completePath(pq, "Documents")).toBe("~/Documents/");
    expect(completePath(parsePathQuery("C:\\Us", win)!, "Users")).toBe("C:\\Users\\");
  });
  it("names the folder typed so far", () => {
    expect(typedFolder(parsePathQuery("C:\\Users\\massi\\", win)!)).toBe("C:\\Users\\massi\\");
    expect(typedFolder(parsePathQuery("C:\\Users\\massi", win)!)).toBe("C:\\Users\\massi");
  });
});
