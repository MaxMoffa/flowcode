import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sortRows, tableToCsv, tableToMarkdown, type MdTable } from "./markdownTable";

type Sort = { column: number; dir: 1 | -1 } | null;

/** A markdown table as a card: a bar with its size, copy as Markdown or CSV
 * and expand (to a dialog over the app), a header that stays while the rows
 * scroll, and a click on a column sorting by it - ascending, descending, then
 * back to the agent's order. `cell` draws a cell's inline markdown. */
export function ChatTable({ table, cell }: { table: MdTable; cell: (text: string, key: string) => ReactNode }) {
  const { t } = useI18n();
  const [sort, setSort] = useState<Sort>(null);
  const [copied, setCopied] = useState<"md" | "csv" | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!expanded) return;
    // Capture phase, handled: an open subagent's Escape (useOpenSubagent) must not also go back.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

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
        <span className="chat-table-size">{t("chat.table.size", { rows: table.rows.length, cols: table.header.length })}</span>
        <span className="chat-table-spacer" />
        <button type="button" className="chat-table-btn" title={t("chat.table.copyMarkdownTitle")} onClick={() => copy("md")}>
          {copied === "md" ? t("chat.table.copied") : "Markdown"}
        </button>
        <button type="button" className="chat-table-btn" title={t("chat.table.copyCsvTitle")} onClick={() => copy("csv")}>
          {copied === "csv" ? t("chat.table.copied") : "CSV"}
        </button>
        <button type="button" className="chat-table-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("chat.table.close") : t("chat.table.expand")}
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
                  <button type="button" className="chat-table-sort" title={t("chat.table.sort")} onClick={() => toggleSort(c)}>
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
            className="chat-table-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setExpanded(false);
            }}
          >
            <div className="chat-table-dialog" role="dialog" aria-modal="true">
              {card}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
