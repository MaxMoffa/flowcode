import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import { sortRows, tableToCsv, tableToMarkdown, type MdTable } from "../../src/chat/markdownTable";

type Sort = { column: number; dir: 1 | -1 } | null;

/** A markdown table as a card: a bar with its size, copy as Markdown or CSV
 * and expand (to a full-screen view), a header that stays while the rows
 * scroll, and a tap on a column sorting by it - ascending, descending, then
 * back to the agent's order. `cell` draws a cell's inline markdown. */
export function ChatTable({ table, cell }: { table: MdTable; cell: (text: string, key: string) => ReactNode }) {
  const [sort, setSort] = useState<Sort>(null);
  const [copied, setCopied] = useState<"md" | "csv" | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

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
        <span className="chat-table-size">{t("chatTableSize", { rows: table.rows.length, cols: table.header.length })}</span>
        <span className="chat-table-spacer" />
        <button type="button" className="chat-table-btn" onClick={() => copy("md")}>
          {copied === "md" ? t("chatTableCopied") : "Markdown"}
        </button>
        <button type="button" className="chat-table-btn" onClick={() => copy("csv")}>
          {copied === "csv" ? t("chatTableCopied") : "CSV"}
        </button>
        <button type="button" className="chat-table-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("chatTableClose") : t("chatTableExpand")}
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
                  <button type="button" className="chat-table-sort" title={t("chatTableSort")} onClick={() => toggleSort(c)}>
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
      {expanded && createPortal(<div className="chat-table-full" role="dialog" aria-modal="true">{card}</div>, document.body)}
    </>
  );
}
