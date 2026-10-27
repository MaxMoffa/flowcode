import { describe, expect, it } from "vitest";
import { isSafeSessionId } from "./sessionId";

describe("isSafeSessionId", () => {
  it("accepts the ids the CLIs use", () => {
    expect(isSafeSessionId("3f2b8c1e-9a4d-4e2f-b7a1-0c9d8e7f6a5b")).toBe(true);
    expect(isSafeSessionId("session_2026-10-27")).toBe(true);
    expect(isSafeSessionId("a".repeat(128))).toBe(true);
  });

  it("refuses anything a shell could read as more than a word", () => {
    for (const id of ["", "a".repeat(129), "abc; rm -rf ~", "$(whoami)", "`id`", "a b", "a&b", "a|b", "../x", "id\n", "a'b", 'a"b', "é"]) {
      expect(isSafeSessionId(id), id).toBe(false);
    }
  });
});
