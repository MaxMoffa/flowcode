import { describe, expect, it } from "vitest";
import { linkAtCell, urlAt } from "./termLinks";

describe("urlAt", () => {
  const line = "see https://example.com/a?b=1, then http://x.dev/p.";
  it("finds the link under the tap", () => {
    expect(urlAt(line, 4)).toBe("https://example.com/a?b=1");
    expect(urlAt(line, 20)).toBe("https://example.com/a?b=1");
    expect(urlAt(line, 40)).toBe("http://x.dev/p");
  });
  it("misses outside links and on trimmed punctuation", () => {
    expect(urlAt(line, 0)).toBeNull();
    expect(urlAt(line, 29)).toBeNull();
    expect(urlAt(line, line.length - 1)).toBeNull();
  });
  it("keeps a balanced closing paren, drops an unbalanced one", () => {
    expect(urlAt("https://en.wikipedia.org/wiki/Foo_(bar)", 10)).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(urlAt("(https://example.com)", 5)).toBe("https://example.com");
  });
  it("ignores other schemes and quotes", () => {
    expect(urlAt("ftp://example.com", 5)).toBeNull();
    expect(urlAt('"https://a.io/x"', 5)).toBe("https://a.io/x");
  });
});

function fake(rows: { s: string; wrapped?: boolean }[]) {
  return {
    length: rows.length,
    getLine: (y: number) => {
      const r = rows[y];
      return r && { isWrapped: !!r.wrapped, translateToString: (trim?: boolean) => (trim ? r.s.trimEnd() : r.s) };
    },
  };
}

describe("linkAtCell", () => {
  const buf = fake([
    { s: "go to https://exa" },
    { s: "mple.com/long/pa", wrapped: true },
    { s: "th ok          ", wrapped: true },
    { s: "https://other.io  " },
  ]);
  it("joins wrapped rows from any of them", () => {
    const want = "https://example.com/long/path";
    expect(linkAtCell(buf, 0, 8)).toBe(want);
    expect(linkAtCell(buf, 1, 3)).toBe(want);
    expect(linkAtCell(buf, 2, 1)).toBe(want);
  });
  it("does not leak into the next logical line", () => {
    expect(linkAtCell(buf, 3, 2)).toBe("https://other.io");
    expect(linkAtCell(buf, 2, 6)).toBeNull();
  });
  it("returns null for a row that does not exist", () => {
    expect(linkAtCell(buf, 9, 0)).toBeNull();
  });
});
