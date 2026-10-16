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
    expect(linkAtCell(buf, 0, 8, 17)).toBe(want);
    expect(linkAtCell(buf, 1, 3, 17)).toBe(want);
    expect(linkAtCell(buf, 2, 1, 17)).toBe(want);
  });
  it("does not leak into the next logical line", () => {
    expect(linkAtCell(buf, 3, 2, 17)).toBe("https://other.io");
    expect(linkAtCell(buf, 2, 6, 17)).toBeNull();
  });
  it("returns null for a row that does not exist", () => {
    expect(linkAtCell(buf, 9, 0, 17)).toBeNull();
  });
});

describe("linkAtCell with rows the app cut", () => {
  const buf = fake([
    { s: "  see https://exa" },
    { s: "  mple.com/very/l" },
    { s: "  ong ok" },
    { s: "  this is a long" },
    { s: "  sentence here" },
  ]);
  it("joins a link the app broke at the edge, past the indent", () => {
    const want = "https://example.com/very/long";
    expect(linkAtCell(buf, 0, 8, 17)).toBe(want);
    expect(linkAtCell(buf, 1, 5, 17)).toBe(want);
    expect(linkAtCell(buf, 2, 3, 17)).toBe(want);
  });
  it("stops after the link and on the indent", () => {
    expect(linkAtCell(buf, 2, 6, 17)).toBeNull();
    expect(linkAtCell(buf, 1, 0, 17)).toBeNull();
  });
  it("leaves prose that reaches the edge alone", () => {
    expect(linkAtCell(buf, 4, 3, 17)).toBeNull();
  });
});
