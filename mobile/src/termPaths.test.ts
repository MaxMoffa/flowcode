import { describe, expect, it } from "vitest";
import type { IBuffer } from "@xterm/xterm";
import { pathAtCell, terminalFile } from "./termPaths";

/** A buffer of plain one-cell characters; `wrapped` rows continue the one above. */
function buffer(rows: string[], wrapped: number[] = []): IBuffer {
  let current = "";
  const cell = { getWidth: () => 1, getChars: () => current };
  return {
    getNullCell: () => cell,
    getLine: (y: number) =>
      y < 0 || y >= rows.length
        ? undefined
        : {
            isWrapped: wrapped.includes(y),
            length: rows[y].length,
            getCell: (x: number) => {
              if (x >= rows[y].length) return undefined;
              current = rows[y][x];
              return cell;
            },
          },
  } as unknown as IBuffer;
}

describe("terminal paths", () => {
  it("finds the path under the tapped cell, including Codex's /C:/ links", () => {
    const buf = buffer(["edited src/app.ts and [x](/C:/repo/lib/b.rs:4) ok"]);
    expect(pathAtCell(buf, 0, 9)).toBe("src/app.ts");
    expect(pathAtCell(buf, 0, 30)).toBe("C:/repo/lib/b.rs");
    expect(pathAtCell(buf, 0, 2)).toBeNull();
  });

  it("joins a path xterm wrapped onto the next row", () => {
    const buf = buffer(["see src/compo", "nents/a.tsx"], [1]);
    expect(pathAtCell(buf, 1, 3)).toBe("src/components/a.tsx");
  });

  it("keeps only files inside the terminal's folder", () => {
    expect(terminalFile("C:/repo/lib/b.rs", "C:\\repo")).toEqual({ path: "lib/b.rs", previewable: false });
    expect(terminalFile("out/page.html", "C:\\repo")).toEqual({ path: "out/page.html", previewable: true });
    expect(terminalFile("C:/other/x.ts", "C:\\repo")).toBeNull();
    expect(terminalFile("/home/u/p/a.md", "/home/u/p")).toEqual({ path: "a.md", previewable: false });
  });
});
