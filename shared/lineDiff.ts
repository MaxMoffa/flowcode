/** One row of a line diff: a line kept, removed from the old text or added in the new one. */
export type DiffRow =
  | { kind: "same"; text: string; oldNo: number; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "add"; text: string; newNo: number };

/** Above this many lines on either side the diff is a plain replacement (Myers' cost grows with the edit distance). */
export const MAX_DIFF_LINES = 4000;

/** Splits text into lines, dropping the empty piece after a final newline. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff of two texts (Myers, O(ND)), in display order; deletions come before the additions that replace them. */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const rows: DiffRow[] = [];
  // Common head and tail need no search.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  for (let i = 0; i < head; i++) rows.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops = am.length > MAX_DIFF_LINES || bm.length > MAX_DIFF_LINES ? replaceAll(am.length, bm.length) : myers(am, bm);
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      rows.push({ kind: "same", text: am[i], oldNo: head + i + 1, newNo: head + j + 1 });
      i++;
      j++;
    } else if (op === "-") {
      rows.push({ kind: "del", text: am[i], oldNo: head + i + 1 });
      i++;
    } else {
      rows.push({ kind: "add", text: bm[j], newNo: head + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < tail; k++) rows.push({ kind: "same", text: a[a.length - tail + k], oldNo: a.length - tail + k + 1, newNo: b.length - tail + k + 1 });
  return rows;
}

type Op = "=" | "-" | "+";

const replaceAll = (n: number, m: number): Op[] => [...Array<Op>(n).fill("-"), ...Array<Op>(m).fill("+")];

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array<Op>(m).fill("+");
  if (m === 0) return Array<Op>(n).fill("-");
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from the end.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const tv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && tv[offset + k - 1] < tv[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = tv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}

/** A run of rows to show: a changed/context group, or `hidden` unchanged rows folded away. */
export type DiffChunk = { rows: DiffRow[]; folded: boolean };

/** Folds runs of more than `limit` unchanged rows, keeping `context` rows next to each change. */
export function foldDiff(rows: DiffRow[], limit = 6, context = 2): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    if (rows[i].kind === "same") {
      while (j < rows.length && rows[j].kind === "same") j++;
      const run = rows.slice(i, j);
      if (run.length > limit) {
        const keepStart = i === 0 ? 0 : context;
        const keepEnd = j === rows.length ? 0 : context;
        if (keepStart > 0) chunks.push({ rows: run.slice(0, keepStart), folded: false });
        chunks.push({ rows: run.slice(keepStart, run.length - keepEnd), folded: true });
        if (keepEnd > 0) chunks.push({ rows: run.slice(run.length - keepEnd), folded: false });
      } else chunks.push({ rows: run, folded: false });
    } else {
      while (j < rows.length && rows[j].kind !== "same") j++;
      chunks.push({ rows: rows.slice(i, j), folded: false });
    }
    i = j;
  }
  return chunks;
}
