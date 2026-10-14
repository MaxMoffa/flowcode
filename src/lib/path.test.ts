import { describe, expect, it } from "vitest";
import { basename, comparablePath, expandHome, extOf, isAbsolutePath, isRootPath, normalizeDir, parentPath, truncatePath } from "./path";

describe("path helpers", () => {
  it("normalizeDir", () => {
    expect(normalizeDir("C:\\a\\b\\")).toBe("C:/a/b");
    expect(normalizeDir("/a/b//")).toBe("/a/b");
  });
  it("basename and extOf", () => {
    expect(basename("C:\\dir\\file.txt")).toBe("file.txt");
    expect(basename("/dir/sub/")).toBe("sub");
    expect(extOf("Main.RS")).toBe("rs");
    expect(extOf(".gitignore")).toBe("");
  });
  it("isAbsolutePath and isRootPath", () => {
    expect(isAbsolutePath("/x")).toBe(true);
    expect(isAbsolutePath("C:\\x")).toBe(true);
    expect(isAbsolutePath("\\\\wsl.localhost\\Ubuntu\\home")).toBe(true);
    expect(isAbsolutePath("rel/x")).toBe(false);
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("\\\\wsl.localhost\\Ubuntu")).toBe(true);
    expect(isRootPath("\\\\wsl.localhost\\Ubuntu\\home")).toBe(false);
  });
  it("parentPath", () => {
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("C:\\a\\b")).toBe("C:\\a");
    expect(parentPath("C:\\a")).toBe("C:\\");
    expect(parentPath("\\\\wsl.localhost\\Ubuntu\\home\\me")).toBe("\\\\wsl.localhost\\Ubuntu\\home");
  });
  it("truncatePath", () => {
    expect(truncatePath("/a/b/c/d")).toBe("\u2026/c/d");
    expect(truncatePath("C:\\a\\b\\c")).toBe("\u2026\\b\\c");
    expect(truncatePath("/a")).toBe("/a");
  });
  it("expandHome", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/x", "/home/me")).toBe("/home/me/x");
    expect(expandHome("~/x", "")).toBe("~/x");
  });
  it("comparablePath", () => {
    expect(comparablePath("C:/Users/Me/")).toBe("c:\\users\\me");
    expect(comparablePath("C:\\Users\\Me")).toBe("c:\\users\\me");
    expect(comparablePath("/Home/Me/")).toBe("/Home/Me");
    expect(comparablePath("C:\\")).toBe("c:\\");
  });
});
