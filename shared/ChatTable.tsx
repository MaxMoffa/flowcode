import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sortRows, tableToCsv, tableToMarkdown, type MdTable } from "../src/chat/markdownTable";

type Sort = { column: number; dir: 1 | -1 } | null;

/** A markdown table as a card: a bar with its size, copy as Markdown or CSV
 * and expand (to a dialog over the app), a header that stays while the rows
 * scroll, and a click on a column sorting by it - ascending, descending, then
 * back to the agent's order. `cell` draws a cell's inline markdown. */
export interface TableLabels {
  size: string; copied: string; close: string; expand: string; sort: string;
  copyMarkdownTitle?: string; copyCsvTitle?: string;
}

export function SharedChatTable({ table, cell, labels, useDismiss, fullScreen = false }: {
  table: MdTable; cell: (text: string, key: string) => ReactNode; labels: TableLabels;
  useDismiss: (open: boolean, close: () => void) => void; fullScreen?: boolean;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const [copied, setCopied] = useState<"md" | "csv" | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const collapse = useCallback(() => setExpanded(false), []);
  useDismiss(expanded, collapse);

  const rows = sort ? sortRows(table.rows, sort.column, sort.dir) : table.rows;
  const copy = (kind: "md" | "csv") => {
    navigator.clipboard.writeText(kind === "md" ? tableToMarkdown(table) : tableToCsv(table)).then(
      () => setCopied(kind),
      () => {},
    );
  };
  const toggleSort = (column: number) =>
    setSort((s) => (!s || s.column !== column ? { column, dir: 1 } : s.dir === 1 ? { column, dir: -1 } : null));

  const card = (
    <div className="chat-table-card">
      <div className="chat-table-bar">
        <span className="chat-table-size">{labels.size}</span>
        <span className="chat-table-spacer" />
        <button type="button" className="chat-table-btn" title={labels.copyMarkdownTitle} onClick={() => copy("md")}>
          {copied === "md" ? labels.copied : "Markdown"}
        </button>
        <button type="button" className="chat-table-btn" title={labels.copyCsvTitle} onClick={() => copy("csv")}>
          {copied === "csv" ? labels.copied : "CSV"}
        </button>
        <button type="button" className="chat-table-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? labels.close : labels.expand}
        </button>
      </div>
      <div className="chat-table-scroll">
        <table className="chat-table">
          <thead>
            <tr>
              {table.header.map((h, c) => (
                <th
                  key={c}
                  style={{ textAlign: table.align[c] }}
                  aria-sort={sort?.column === c ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                >
                  <button type="button" className="chat-table-sort" title={labels.sort} onClick={() => toggleSort(c)}>
                    {cell(h, `h${c}`)}
                    <span className={"chat-table-sort-mark" + (sort?.column === c ? " is-on" : "")} aria-hidden="true">
                      {sort?.column === c ? (sort.dir === 1 ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r}>
                {cells.map((v, c) => (
                  <td key={c} style={{ textAlign: table.align[c] }}>
                    {cell(v, `${r}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <>
      {card}
      {expanded &&
        createPortal(
          <div
            className={fullScreen ? "chat-table-full" : "chat-table-backdrop"}
            role={fullScreen ? "dialog" : undefined}
            aria-modal={fullScreen ? true : undefined}
            onMouseDown={(e) => {
              if (!fullScreen && e.target === e.currentTarget) setExpanded(false);
            }}
          >
            {fullScreen ? card : <div className="chat-table-dialog" role="dialog" aria-modal="true">{card}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
