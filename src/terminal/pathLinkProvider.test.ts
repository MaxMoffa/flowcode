import { describe, expect, it, vi } from "vitest";
import type { IBuffer, IBufferCell, IBufferLine, ILink } from "@xterm/xterm";
import { createPathLinkProvider, logicalLine, pathsOnRow } from "./pathLinkProvider";
import type { PathTarget } from "../lib/fileLinks";

/** One cell: its text and width (2 = wide, followed by a 0-width cell). */
type FakeCell = { chars: string; width: number };

/** A buffer of fixed-width rows; `wrapped` rows continue the one above. Wide characters are written "W" + a following "" cell. */
function fakeBuffer(rows: { text: string; wrapped?: boolean }[], cols: number): IBuffer {
  const lines: IBufferLine[] = rows.map(({ text, wrapped }) => {
    const cells: FakeCell[] = [];
    for (const ch of Array.from(text)) {
      if (ch === "界") {
        cells.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
      } else cells.push({ chars: ch, width: 1 });
    }
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: !!wrapped,
      length: cols,
      getCell: (x: number, into?: IBufferCell) => {
        const c = cells[x];
        if (!c) return undefined;
        const target = (into ?? {}) as { current?: FakeCell };
        target.current = c;
        return target as unknown as IBufferCell;
      },
      translateToString: () => text,
    } as unknown as IBufferLine;
  });
  const nullCell = {
    current: undefined as FakeCell | undefined,
    getChars() {
      return this.current?.chars ?? "";
    },
    getWidth() {
      return this.current?.width ?? 1;
    },
  };
  return {
    getLine: (y: number) => lines[y],
    getNullCell: () => nullCell as unknown as IBufferCell,
  } as unknown as IBuffer;
}

describe("logicalLine", () => {
  it("joins soft-wrapped rows and maps each character to its cell", () => {
    const buf = fakeBuffer([{ text: "see src/ch" }, { text: "at/a.ts ok", wrapped: true }, { text: "next" }], 10);
    const line = logicalLine(buf, 1);
    expect(line.text).toBe("see src/chat/a.ts ok");
    expect(line.cells[4]).toEqual({ x: 5, y: 1 });
    expect(line.cells[10]).toEqual({ x: 1, y: 2 });
    // The unwrapped next row is a line of its own.
    expect(logicalLine(buf, 2).text.trimEnd()).toBe("next");
  });

  it("skips the second half of wide characters", () => {
    const line = logicalLine(fakeBuffer([{ text: "界 src/a.ts" }], 12), 0);
    expect(line.text.startsWith("界 src/a.ts")).toBe(true);
    // "s" of src sits after the two-cell character and the space.
    expect(line.cells[2]).toEqual({ x: 4, y: 1 });
  });
});

describe("pathsOnRow", () => {
  it("keeps only the candidates touching the row", () => {
    const buf = fakeBuffer([{ text: "./a/b.ts x" }, { text: "y ./c/d.ts", wrapped: true }], 10);
    const line = logicalLine(buf, 0);
    expect(pathsOnRow(line, 1).map((m) => m.path)).toEqual(["./a/b.ts"]);
    expect(pathsOnRow(line, 2).map((m) => m.path)).toEqual(["./c/d.ts"]);
  });

  it("returns a wrapped path on both of its rows", () => {
    const line = logicalLine(fakeBuffer([{ text: "see src/ch" }, { text: "at/a.ts ok", wrapped: true }], 10), 0);
    expect(pathsOnRow(line, 1).map((m) => m.path)).toEqual(["src/chat/a.ts"]);
    expect(pathsOnRow(line, 2).map((m) => m.path)).toEqual(["src/chat/a.ts"]);
  });
});

describe("createPathLinkProvider", () => {
  const target: PathTarget = { path: "C:\\proj\\src\\a.ts", kind: "file", text: true };

  it("links only the paths that exist, never urls", async () => {
    const buf = fakeBuffer([{ text: "src/a.ts:3 src/gone.ts https://x.io/a/b" }], 40);
    const check = vi.fn(async (p: string) => (p === "src/a.ts" ? target : null));
    const activate = vi.fn();
    const provider = createPathLinkProvider(() => buf, check, activate);
    const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    expect(check).toHaveBeenCalledTimes(2);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("src/a.ts:3");
    expect(links![0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 10, y: 1 } });
    links![0].activate({} as MouseEvent, links![0].text);
    expect(activate).toHaveBeenCalledWith({}, target, 3);
  });

  it("answers undefined at once for a line without candidates", () => {
    const callback = vi.fn();
    const check = vi.fn();
    createPathLinkProvider(() => fakeBuffer([{ text: "hello world" }], 20), check, vi.fn()).provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
    expect(check).not.toHaveBeenCalled();
  });
});
