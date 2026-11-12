import type { IBuffer } from "@xterm/xterm";
import { isPreviewableFile } from "../../shared/agentOpen";
import { logicalLine, pathsOnRow } from "../../src/terminal/pathLinkProvider";
import { relativeArtifactPath } from "./agentPreview";

/** The file path printed at buffer cell (row, col), both 0-based - found the way the desktop terminal finds them. */
export function pathAtCell(buf: IBuffer, row: number, col: number): string | null {
  const line = logicalLine(buf, row);
  const at = { x: col + 1, y: row + 1 };
  const upTo = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y < b.y || (a.y === b.y && a.x <= b.x);
  for (const m of pathsOnRow(line, at.y)) {
    if (upTo(line.cells[m.start], at) && upTo(at, line.cells[m.end - 1])) return m.path;
  }
  return null;
}

/** A tapped path as the terminal's folder sees it: relative to `cwd` (the desktop only serves files inside it), and
 * whether the in-app browser shows it (else it opens as text). Null for a path outside the folder. */
export function terminalFile(path: string, cwd: string): { path: string; previewable: boolean } | null {
  const relative = relativeArtifactPath(path, cwd, cwd);
  return relative ? { path: relative, previewable: isPreviewableFile(relative) } : null;
}
