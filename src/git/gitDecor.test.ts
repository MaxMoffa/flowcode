import { describe, expect, it } from "vitest";
import { buildGitDecor } from "./gitDecor";
import type { GitChange, GitStatus } from "./gitStatus";

const ch = (path: string, status = "M"): GitChange => ({ path, orig_path: null, status });
const status = (p: Partial<GitStatus>): GitStatus => ({
  branch: "main",
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  ...p,
});

describe("buildGitDecor", () => {
  it("letters a modified file and marks its ancestors", () => {
    const d = buildGitDecor("/repo", status({ unstaged: [ch("src/a/x.ts")] }));
    expect(d.file("/repo/src/a/x.ts")).toBe("M");
    expect(d.dir("/repo/src/a")).toBe(true);
    expect(d.dir("/repo/src")).toBe(true);
    expect(d.dir("/repo/other")).toBe(false);
    expect(d.dir("/repo/src/a/x.ts")).toBe(false);
  });

  it("treats an untracked folder as a changed dir", () => {
    const d = buildGitDecor("/repo", status({ untracked: [ch("newdir/", "?")] }));
    expect(d.dir("/repo/newdir")).toBe(true);
    expect(d.file("/repo/newdir")).toBe("U");
  });

  it("prioritises conflict, then unstaged over staged", () => {
    const d = buildGitDecor(
      "/repo",
      status({ conflicted: [ch("c.ts", "U")], staged: [ch("c.ts", "A"), ch("s.ts", "A")], unstaged: [ch("s.ts", "M")] }),
    );
    expect(d.file("/repo/c.ts")).toBe("!");
    expect(d.file("/repo/s.ts")).toBe("M");
  });

  it("deleted files get no letter but still mark ancestors", () => {
    const d = buildGitDecor("/repo", status({ unstaged: [ch("gone/f.ts", "D")] }));
    expect(d.file("/repo/gone/f.ts")).toBeUndefined();
    expect(d.dir("/repo/gone")).toBe(true);
  });

  it("matches Windows paths case-insensitively", () => {
    const d = buildGitDecor("C:\\repo", status({ staged: [ch("src/a.ts", "A")] }));
    expect(d.file("c:\\REPO\\src\\a.ts")).toBe("A");
    expect(d.dir("C:\\repo\\src")).toBe(true);
  });
});
