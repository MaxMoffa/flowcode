import { describe, expect, it } from "vitest";
import { findPaths, isExecutablePath, MAX_PATH_LENGTH, parsePathToken, shortenPath } from "./filePaths";

/** The path texts found in `text`, as written (suffix included). */
const found = (text: string, bare = false) => findPaths(text, { bare }).map((m) => text.slice(m.start, m.end));
const paths = (text: string) => findPaths(text).map((m) => m.path);

describe("parsePathToken", () => {
  it("takes absolute paths of every shape", () => {
    expect(parsePathToken("C:\\foo\\bar.ts")).toEqual({ path: "C:\\foo\\bar.ts" });
    expect(parsePathToken("C:/foo/bar.ts")).toEqual({ path: "C:/foo/bar.ts" });
    expect(parsePathToken("\\\\wsl.localhost\\Ubuntu\\x")).toEqual({ path: "\\\\wsl.localhost\\Ubuntu\\x" });
    expect(parsePathToken("\\\\WSL$\\Ubuntu\\x")).toEqual({ path: "\\\\WSL$\\Ubuntu\\x" });
    expect(parsePathToken("/home/u/x.ts")).toEqual({ path: "/home/u/x.ts" });
    expect(parsePathToken("~/x")).toEqual({ path: "~/x" });
  });

  it("refuses UNC shares other than WSL's, and device paths", () => {
    for (const p of [
      "\\\\server\\share\\x",
      "\\\\attacker\\share\\a.txt",
      "\\\\host@SSL@443\\x\\a",
      "\\\\.\\pipe\\x",
      "\\\\.\\C:\\x",
      "\\\\?\\C:\\x",
      "\\\\?\\UNC\\server\\share\\x",
      "\\\\wsl.localhost.evil.com\\share\\x",
    ]) {
      expect(parsePathToken(p), p).toBeNull();
    }
  });

  it("takes relative paths with a separator", () => {
    expect(parsePathToken("src/chat/useChat.ts")?.path).toBe("src/chat/useChat.ts");
    expect(parsePathToken("src\\chat\\useChat.ts")?.path).toBe("src\\chat\\useChat.ts");
    expect(parsePathToken("./a/b")?.path).toBe("./a/b");
    expect(parsePathToken("../a/b")?.path).toBe("../a/b");
    expect(parsePathToken("src/chat/")?.path).toBe("src/chat/");
    expect(parsePathToken("src/")).toEqual({ path: "src/" });
  });

  it("takes a bare folder name without an extension only when asked (for a code span)", () => {
    expect(parsePathToken("src-tauri", { bare: true })).toBeNull();
    expect(parsePathToken("src-tauri", { bare: true, bareAny: true })).toEqual({ path: "src-tauri" });
    expect(parsePathToken("42", { bare: true, bareAny: true })).toBeNull();
  });

  it("splits off a line and column", () => {
    expect(parsePathToken("src/App.tsx:120:4")).toEqual({ path: "src/App.tsx", line: 120, col: 4 });
    expect(parsePathToken("src/App.tsx:120")).toEqual({ path: "src/App.tsx", line: 120 });
    expect(parsePathToken("C:\\x\\y.ts:7")).toEqual({ path: "C:\\x\\y.ts", line: 7 });
    expect(parsePathToken("src/a.ts(12,5)")).toEqual({ path: "src/a.ts", line: 12, col: 5 });
  });

  it("takes bare file names only when asked, and only with a known extension", () => {
    expect(parsePathToken("useChat.ts")).toBeNull();
    expect(parsePathToken("useChat.ts", { bare: true })).toEqual({ path: "useChat.ts" });
    expect(parsePathToken("useChat.ts:12", { bare: true })).toEqual({ path: "useChat.ts", line: 12 });
    expect(parsePathToken("Cargo.lock", { bare: true })?.path).toBe("Cargo.lock");
    expect(parsePathToken("Makefile", { bare: true })?.path).toBe("Makefile");
    expect(parsePathToken("foo.unknownext", { bare: true })).toBeNull();
    expect(parsePathToken("1.2.3", { bare: true })).toBeNull();
    expect(parsePathToken("v1.2.3", { bare: true })).toBeNull();
    expect(parsePathToken("useState", { bare: true })).toBeNull();
  });

  it("refuses urls but strips file://", () => {
    expect(parsePathToken("https://example.com/a/b")).toBeNull();
    expect(parsePathToken("http://x/y.ts")).toBeNull();
    expect(parsePathToken("ftp://x/y")).toBeNull();
    expect(parsePathToken("mailto:a/b")).toBeNull();
    expect(parsePathToken("file:///C:/Users/me/a%20b.txt")).toEqual({ path: "C:/Users/me/a b.txt" });
    expect(parsePathToken("file:///home/me/x.ts")).toEqual({ path: "/home/me/x.ts" });
    expect(parsePathToken("file:///bad%")).toBeNull();
    expect(parsePathToken("file:///a%00b")).toBeNull();
  });

  it("refuses numbers, dates, fractions and other look-alikes", () => {
    expect(parsePathToken("1/2")).toBeNull();
    expect(parsePathToken("12/05/2024")).toBeNull();
    expect(parsePathToken("2024-01-02")).toBeNull();
    expect(parsePathToken("1.2.3")).toBeNull();
    expect(parsePathToken("/")).toBeNull();
    expect(parsePathToken("//comment")).toBeNull();
    expect(parsePathToken("~")).toBeNull();
    expect(parsePathToken("node:fs/promises")).toBeNull();
    expect(parsePathToken("host:path/x")).toBeNull();
    expect(parsePathToken("--out/dir")).toBeNull();
    expect(parsePathToken("src/*.ts")).toBeNull();
    expect(parsePathToken("a/b?x=1")).toBeNull();
    expect(parsePathToken("word")).toBeNull();
  });

  it("refuses NUL, control characters, spaces unless quoted, and oversized input", () => {
    expect(parsePathToken("a/b\0c")).toBeNull();
    expect(parsePathToken("a/b\nc")).toBeNull();
    expect(parsePathToken("C:\\Program Files\\x.txt")).toBeNull();
    expect(parsePathToken("C:\\Program Files\\x.txt", { spaces: true })?.path).toBe("C:\\Program Files\\x.txt");
    expect(parsePathToken(" a/b", { spaces: true })).toBeNull();
    expect(parsePathToken(`/${"a".repeat(MAX_PATH_LENGTH)}`)).toBeNull();
  });
});

describe("findPaths", () => {
  it("finds paths in prose, trimming sentence punctuation", () => {
    expect(found("See src/chat/useChat.ts, then ./a/b.")).toEqual(["src/chat/useChat.ts", "./a/b"]);
    expect(found("Edited C:\\foo\\bar.ts: done")).toEqual(["C:\\foo\\bar.ts"]);
    expect(found("(in /home/u/x.ts)")).toEqual(["/home/u/x.ts"]);
    expect(found("at Object.<anonymous> (C:\\x\\y.js:10:5)")).toEqual(["C:\\x\\y.js:10:5"]);
    expect(found("error src/a.ts(12,5): bad")).toEqual(["src/a.ts(12,5)"]);
  });

  it("keeps the line suffix inside the link and reports it", () => {
    const [m] = findPaths("open src/App.tsx:120:4 now");
    expect(m).toEqual({ start: 5, end: 22, path: "src/App.tsx", line: 120, col: 4 });
  });

  it("supports quoted paths with spaces", () => {
    expect(paths('copy "C:\\Program Files\\x\\y.txt" there')).toEqual(["C:\\Program Files\\x\\y.txt"]);
    expect(paths("in '/home/me/my file.md' ok")).toEqual(["/home/me/my file.md"]);
    expect(paths("run `src/a b/c.ts`")).toEqual(["src/a b/c.ts"]);
  });

  it("stops unquoted paths at whitespace", () => {
    // Two candidates, both dropped later by the existence check.
    expect(paths("C:\\Program Files\\x.txt")).toEqual(["C:\\Program", "Files\\x.txt"]);
    expect(paths("/home/me/my file.md")).toEqual(["/home/me/my"]);
  });

  it("is not thrown by apostrophes", () => {
    expect(paths("it's in src/a.ts, isn't it")).toEqual(["src/a.ts"]);
  });

  it("leaves urls and numbers alone", () => {
    expect(paths("see https://example.com/a/b.ts and 1/2 on 12/05/2024 v1.2.3")).toEqual([]);
  });

  it("takes the target of a markdown link", () => {
    expect(found("[the file](src/a.ts)")).toEqual(["src/a.ts"]);
  });

  it("finds bare names only when asked", () => {
    expect(found("edit useChat.ts")).toEqual([]);
    expect(found("edit useChat.ts", true)).toEqual(["useChat.ts"]);
  });
});

describe("isExecutablePath", () => {
  it("flags programs and scripts, case-insensitively", () => {
    for (const p of ["a.exe", "C:\\x\\run.BAT", "x.cmd", "s.ps1", "i.sh", "setup.msi", "l.lnk", "v.vbs", "a.js", "t.py"]) {
      expect(isExecutablePath(p)).toBe(true);
    }
  });
  it("flags the newer Windows handlers and names Windows trims to an executable", () => {
    for (const p of ["h.chm", "x.xll", "p.appx", "a.appinstaller", "d.iso", "v.vhdx", "s.settingcontent-ms", "c.library-ms", "a.exe.", "a.exe "]) {
      expect(isExecutablePath(p), p).toBe(true);
    }
  });
  it("lets documents through", () => {
    for (const p of ["a.ts", "b.png", "c.pdf", "README", "x.txt", "dir/"]) expect(isExecutablePath(p)).toBe(false);
  });
});

describe("shortenPath", () => {
  it("keeps short paths and the end of long ones", () => {
    expect(shortenPath("C:\\a.ts")).toBe("C:\\a.ts");
    const long = `C:\\${"d\\".repeat(40)}file.ts`;
    const short = shortenPath(long);
    expect(short).toHaveLength(60);
    expect(short.startsWith("…")).toBe(true);
    expect(short.endsWith("file.ts")).toBe(true);
  });
});
