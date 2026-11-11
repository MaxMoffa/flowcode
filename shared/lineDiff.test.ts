import { describe, expect, it } from "vitest";
import { foldDiff, lineDiff, MAX_DIFF_LINES } from "./lineDiff";

/** Rebuilds both texts from the rows: a correct diff round-trips. */
const sides = (rows: ReturnType<typeof lineDiff>) => ({
  old: rows.filter((r) => r.kind !== "add").map((r) => r.text),
  next: rows.filter((r) => r.kind !== "del").map((r) => r.text),
});

describe("lineDiff", () => {
  it("marks identical text as unchanged", () => {
    expect(lineDiff("a\nb\n", "a\nb\n").every((r) => r.kind === "same")).toBe(true);
  });
  it("treats an empty old text as all added", () => {
    const rows = lineDiff("", "x\ny\n");
    expect(rows.map((r) => r.kind)).toEqual(["add", "add"]);
    expect(rows[1]).toMatchObject({ newNo: 2 });
  });
  it("treats an empty new text as all removed", () => {
    expect(lineDiff("x\ny\n", "").map((r) => r.kind)).toEqual(["del", "del"]);
  });
  it("finds a changed middle line with numbers", () => {
    const rows = lineDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(rows.map((r) => r.kind)).toEqual(["same", "del", "add", "same"]);
    expect(rows[3]).toMatchObject({ oldNo: 3, newNo: 3 });
  });
  it("round-trips a scattered edit", () => {
    const a = "a\nb\nc\nd\ne\nf\ng\n";
    const b = "a\nc\nd\nX\ne\nf\ng\nh\n";
    const { old, next } = sides(lineDiff(a, b));
    expect(old.join("\n")).toBe("a\nb\nc\nd\ne\nf\ng");
    expect(next.join("\n")).toBe("a\nc\nd\nX\ne\nf\ng\nh");
  });
  it("falls back to a whole replacement past the size guard", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`);
    const rows = lineDiff(big.join("\n") + "\nA", big.join("\n") + "\nB\nC");
    const { old, next } = sides(rows);
    expect(old).toHaveLength(MAX_DIFF_LINES + 2);
    expect(next).toHaveLength(MAX_DIFF_LINES + 3);
  });
});

describe("foldDiff", () => {
  it("folds long unchanged runs but keeps context around changes", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a];
    b[15] = "changed";
    const chunks = foldDiff(lineDiff(a.join("\n"), b.join("\n")));
    expect(chunks.filter((c) => c.folded)).toHaveLength(2);
    expect(chunks.flatMap((c) => c.rows).length).toBe(31);
  });
  it("keeps short runs open", () => {
    expect(foldDiff(lineDiff("a\nb\nc\n", "a\nX\nc\n")).some((c) => c.folded)).toBe(false);
  });
});
