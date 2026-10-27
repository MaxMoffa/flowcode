import type { IBuffer, IBufferCellPosition, ILink, ILinkProvider } from "@xterm/xterm";
import { findPaths, type PathMatch } from "../lib/filePaths";
import type { PathTarget } from "../lib/fileLinks";

/** Rows of one wrapped line joined at most - a minified bundle printed on one line shouldn't be scanned whole. */
const MAX_WRAPPED_ROWS = 32;

export interface LogicalLine {
  text: string;
  /** Buffer cell (1-based x and y, xterm's link coordinates) of each UTF-16 unit of `text`. */
  cells: IBufferCellPosition[];
}

/** The whole (soft-wrapped) line `row` (0-based) belongs to, with where each
 * character sits - wide characters take two cells, so string indexes and
 * columns don't line up on their own. */
export function logicalLine(buffer: IBuffer, row: number): LogicalLine {
  let first = row;
  while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first--;
  let last = row;
  while (last - first < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last++;
  let text = "";
  const cells: IBufferCellPosition[] = [];
  const cell = buffer.getNullCell();
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell)) break;
      // The second half of a wide character.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let k = 0; k < chars.length; k++) {
        text += chars[k];
        cells.push({ x: x + 1, y: y + 1 });
      }
    }
  }
  return { text, cells };
}

/** The path candidates of a logical line that touch buffer row `y` (1-based). */
export function pathsOnRow(line: LogicalLine, y: number): PathMatch[] {
  return findPaths(line.text).filter((m) => line.cells[m.start].y <= y && line.cells[m.end - 1].y >= y);
}

/** Paths printed in the terminal as links: found by shape, offered only once
 * the disk says they exist (`check`, cached), opened through `activate`.
 * `check` returning null for everything (no cwd, links off) just yields none. */
export function createPathLinkProvider(
  getBuffer: () => IBuffer,
  check: (path: string) => Promise<PathTarget | null>,
  activate: (event: MouseEvent, target: PathTarget, line?: number) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = logicalLine(getBuffer(), y - 1);
      const matches = pathsOnRow(line, y);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(matches.map((m) => check(m.path))).then((targets) => {
        const links: ILink[] = [];
        matches.forEach((m, i) => {
          const target = targets[i];
          if (!target) return;
          links.push({
            range: { start: line.cells[m.start], end: line.cells[m.end - 1] },
            text: line.text.slice(m.start, m.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => activate(event, target, m.line),
          });
        });
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
