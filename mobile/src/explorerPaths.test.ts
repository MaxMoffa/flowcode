import { describe, expect, it } from "vitest";
import { launchPath, parentFromPath, pathCrumbs } from "./explorerPaths";

describe("absolute explorer paths", () => {
  it("keeps Windows drives absolute while navigating upward", () => {
    expect(pathCrumbs("C:\\Users\\massi").map((c) => c.path)).toEqual(["C:/", "C:/Users", "C:/Users/massi"]);
    expect(parentFromPath("C:/Users")).toBe("C:/");
    expect(parentFromPath("C:/")).toBeNull();
  });
  it("keeps WSL navigation inside the share and launches with native UNC separators", () => {
    const path = "//wsl.localhost/Ubuntu/home/massi";
    expect(pathCrumbs(path).map((c) => c.path)).toEqual(["//wsl.localhost/Ubuntu", "//wsl.localhost/Ubuntu/home", path]);
    expect(parentFromPath("//wsl.localhost/Ubuntu")).toBeNull();
    expect(launchPath(path)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\massi");
    expect(launchPath("//wsl$/Debian/home")).toBe("\\\\wsl$\\Debian\\home");
  });
  it("preserves POSIX roots, spaces and unicode", () => {
    expect(pathCrumbs("/home/Progetti città").map((c) => c.path)).toEqual(["/", "/home", "/home/Progetti città"]);
    expect(parentFromPath("/")).toBeNull();
    expect(launchPath("/home/user")).toBe("/home/user");
    expect(launchPath("C:/Users/My Projects")).toBe("C:/Users/My Projects");
  });
});
