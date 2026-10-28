/** GitHub-style pipe tables in an agent's markdown: a header row, a
 * delimiter row (`| --- | :-: |`), then body rows up to the first line
 * without a pipe. */

export type CellAlign = "left" | "center" | "right" | undefined;

export interface MdTable {
  header: string[];
  align: CellAlign[];
  rows: string[][];
}

/** The cells of a table row: split on the pipes not escaped (`\|`) nor
 * inside `code`, the outer pipes dropped, each cell trimmed. */
export function splitRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  const trimmed = row.trim();
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|") && cells.length > 0) cells.pop();
  return cells.map((c) => c.trim());
}

const DELIMITER_CELL = /^:?-+:?$/;

function alignOf(cell: string): CellAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : undefined;
}

/** The table starting at `rows[start]`, if one does, and the index of the
 * first row after it. Body rows short of cells are padded, longer ones cut. */
export function readTable(rows: string[], start: number): { table: MdTable; next: number } | null {
  const head = rows[start];
  const delimiter = rows[start + 1];
  if (head === undefined || delimiter === undefined || !head.includes("|") || !delimiter.includes("|") || !delimiter.includes("-")) return null;
  const delims = splitRow(delimiter);
  if (delims.length === 0 || !delims.every((c) => DELIMITER_CELL.test(c))) return null;
  const header = splitRow(head);
  if (header.length !== delims.length) return null;
  const fit = (cells: string[]) => header.map((_, i) => cells[i] ?? "");
  const body: string[][] = [];
  let i = start + 2;
  for (; i < rows.length && rows[i].includes("|") && rows[i].trim() !== ""; i++) body.push(fit(splitRow(rows[i])));
  return { table: { header, align: delims.map(alignOf), rows: body }, next: i };
}

/** A cell's text without its inline markup: `code` and **bold** marks
 * dropped, a [text](url) link as its text. */
export function plainCell(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The rows ordered by one column, the numbers in it by value ("7 ms"
 * before "42 ms"); rows that compare equal keep their order. */
export function sortRows(rows: string[][], column: number, dir: 1 | -1): string[][] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => collator.compare(plainCell(a.row[column] ?? ""), plainCell(b.row[column] ?? "")) * dir || a.i - b.i)
    .map((x) => x.row);
}

/** The table back as markdown, pipes in cells escaped. */
export function tableToMarkdown(table: MdTable): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  const delimiter = table.align.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"));
  return [line(table.header), `| ${delimiter.join(" | ")} |`, ...table.rows.map(line)].join("\n");
}

/** The table as CSV (RFC 4180): cells as plain text, quoted when they hold a
 * comma, semicolon, quote or line break. */
export function tableToCsv(table: MdTable): string {
  const field = (cell: string) => {
    const text = plainCell(cell);
    return /[",;\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [table.header, ...table.rows].map((cells) => cells.map(field).join(",")).join("\r\n");
}
