import { describe, expect, it } from "vitest";
import { plainCell, readTable, sortRows, splitRow, tableToCsv, tableToMarkdown, type MdTable } from "./markdownTable";

describe("splitRow", () => {
  it("splits on pipes and drops the outer ones", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
  });

  it("keeps pipes inside code and escaped pipes in the cell", () => {
    expect(splitRow("| `x|y` | z |")).toEqual(["`x|y`", "z"]);
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });
});

describe("readTable", () => {
  it("reads the header, alignment, body rows and the next index", () => {
    const rows = ["| Name | Size |", "| :--- | ---: |", "| a | 1 |", "| b | 2 |", "", "after"];
    expect(readTable(rows, 0)).toEqual({
      table: {
        header: ["Name", "Size"],
        align: ["left", "right"],
        rows: [
          ["a", "1"],
          ["b", "2"],
        ],
      },
      next: 4,
    });
  });

  it("reads center alignment and no alignment", () => {
    const table = readTable(["| a | b |", "| :-: | --- |"], 0)?.table;
    expect(table?.align).toEqual(["center", undefined]);
  });

  it("pads short body rows and cuts long ones to the header width", () => {
    const rows = ["| a | b |", "| - | - |", "| 1 |", "| 1 | 2 | 3 |"];
    expect(readTable(rows, 0)?.table.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("returns null when the delimiter row is missing", () => {
    expect(readTable(["| a | b |"], 0)).toBeNull();
  });

  it("returns null when a delimiter cell is not a delimiter", () => {
    expect(readTable(["| a | b |", "| --- | abc |"], 0)).toBeNull();
  });

  it("returns null when header and delimiter cell counts differ", () => {
    expect(readTable(["| a | b |", "| --- |"], 0)).toBeNull();
  });

  it("returns null for a plain sentence with a pipe", () => {
    expect(readTable(["a | b", "normal line"], 0)).toBeNull();
  });
});

describe("plainCell", () => {
  it("drops code and bold marks and keeps a link's text", () => {
    expect(plainCell("`a.ts`")).toBe("a.ts");
    expect(plainCell("**x** [doc](https://e.com)")).toBe("x doc");
  });
});

describe("sortRows", () => {
  const rows = [
    ["b", "42 ms"],
    ["a", "7 ms"],
    ["c", "100 ms"],
  ];

  it("sorts ascending and descending, numbers by value", () => {
    expect(sortRows(rows, 1, 1).map((r) => r[0])).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, 1, -1).map((r) => r[0])).toEqual(["c", "b", "a"]);
  });

  it("keeps the original order of rows that tie", () => {
    const tied = [
      ["same", "1"],
      ["other", "2"],
      ["same", "3"],
    ];
    expect(sortRows(tied, 0, 1).map((r) => r[1])).toEqual(["2", "1", "3"]);
  });

  it("ignores markup in the cells", () => {
    expect(sortRows([["`zeta`"], ["alpha"]], 0, 1)).toEqual([["alpha"], ["`zeta`"]]);
  });
});

describe("tableToMarkdown", () => {
  it("writes the table back with its alignment and escaped pipes", () => {
    const table: MdTable = { header: ["A", "B"], align: ["left", "right"], rows: [["1", "x|y"]] };
    expect(tableToMarkdown(table)).toBe("| A | B |\n| :--- | ---: |\n| 1 | x\\|y |");
  });
});

describe("tableToCsv", () => {
  it("quotes the cells that hold a comma, quote or semicolon", () => {
    const table = { header: ["File", "Note"], align: [undefined, undefined], rows: [["`a.ts`", 'ok, "fine"']] };
    expect(tableToCsv(table)).toBe('File,Note\r\na.ts,"ok, ""fine"""');
  });
});
