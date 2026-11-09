import { describe, expect, it } from "vitest";
import { permissionDetail } from "./permissionDetail";

describe("permissionDetail", () => {
  it("shows Codex's command behind a generic title", () => {
    expect(permissionDetail({ toolCallId: "1", title: "Run command", rawInput: { command: "npm test", cwd: "/x" } })).toBe("npm test");
    expect(permissionDetail({ toolCallId: "1", title: "Run command", rawInput: { command: ["git", "push"] } })).toBe("git push");
  });
  it("lists the files of an edit", () => {
    expect(permissionDetail({ toolCallId: "1", title: "Edit files", locations: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe("a.ts\nb.ts");
  });
  it("adds nothing the title already says", () => {
    expect(permissionDetail({ toolCallId: "1", title: "`npm test`", rawInput: { command: "npm test" } })).toBeNull();
    expect(permissionDetail({ toolCallId: "1", title: "Run command" })).toBeNull();
  });
});
