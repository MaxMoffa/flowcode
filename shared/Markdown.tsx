import { useEffect, useState, type ReactNode } from "react";
import { parseBlocks, parseInline, type Block, type Inline } from "../src/chat/markdownBlocks";
import type { MdTable } from "../src/chat/markdownTable";

/** Platform adapters keep filesystem links, image ownership and navigation outside the renderer. */
export interface MarkdownAdapters {
  text(text: string, key: string, label?: (text: string, key: string) => ReactNode): ReactNode;
  code(text: string, key: string): ReactNode;
  image(src: string, alt: string, key: string): ReactNode;
  table(table: MdTable, cell: (text: string, key: string) => ReactNode, key: string): ReactNode;
  copyLabels: { copy: string; copied: string; title?: string };
}

/** Inline tokens as React nodes: formatting, `code` (paths linked), links, and the text between them with its urls and file paths linked. */
function inline(tokens: Inline[], keyBase: string, adapter: MarkdownAdapters): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyBase}-${i}`;
    switch (tok.type) {
      case "text":
        return adapter.text(tok.text, key);
      case "code":
        return adapter.code(tok.text, key);
      case "link":
        return adapter.text(tok.raw, key, (label, k) => inline(parseInline(label), k, adapter));
      case "image":
        return adapter.image(tok.src, tok.alt, key);
      case "strong":
        return <strong key={key}>{inline(tok.children, key, adapter)}</strong>;
      case "em":
        return <em key={key}>{inline(tok.children, key, adapter)}</em>;
      case "del":
        return <del key={key}>{inline(tok.children, key, adapter)}</del>;
    }
  });
}

/** Lines joined with <br />, each through `inline`. */
function lines(rows: string[], keyBase: string, adapter: MarkdownAdapters): ReactNode[] {
  const out: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(parseInline(row), `${keyBase}-${i}`, adapter));
  });
  return out;
}

/** A fenced block: the language and a Copy button over the code. */
function CodeBlock({ lang, text, labels }: { lang: string; text: string; labels: MarkdownAdapters["copyLabels"] }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span className="chat-code-lang">{lang}</span>
        <button
          type="button"
          className="chat-table-btn"
          title={labels.title}
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? labels.copied : labels.copy}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A list item's blocks; a task item's checkbox leads its first paragraph. */
function item(it: { checked: boolean | null; blocks: Block[] }, keyBase: string, adapter: MarkdownAdapters): ReactNode {
  if (it.checked === null) return blocks(it.blocks, keyBase, adapter);
  const box = <input key={`${keyBase}-box`} type="checkbox" checked={it.checked} disabled readOnly />;
  const [first, ...rest] = it.blocks;
  if (first?.type === "paragraph") {
    return [<p key={`${keyBase}-p`}>{[box, ...lines(first.lines, `${keyBase}-p`, adapter)]}</p>, ...blocks(rest, keyBase, adapter, 1)];
  }
  return [box, ...blocks(it.blocks, keyBase, adapter)];
}

function blocks(list: Block[], keyBase: string, adapter: MarkdownAdapters, offset = 0): ReactNode[] {
  return list.map((b, n) => {
    const key = `${keyBase}-${n + offset}`;
    switch (b.type) {
      case "paragraph":
        return <p key={key}>{lines(b.lines, key, adapter)}</p>;
      case "heading": {
        // Levels 1-3 are three sizes; 4-6 share the small one.
        const Tag = b.level <= 3 ? (`h${b.level + 1}` as "h2" | "h3" | "h4") : "h5";
        return (
          <Tag key={key} className={`chat-h chat-h${Math.min(b.level, 4)}`}>
            {inline(parseInline(b.text), key, adapter)}
          </Tag>
        );
      }
      case "code":
        return <CodeBlock key={key} lang={b.lang} text={b.text} labels={adapter.copyLabels} />;
      case "table":
        return adapter.table(b.table, (text, cellKey) => inline(parseInline(text), `${key}-${cellKey}`, adapter), key);
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={key} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, i) => (
              <li key={i} className={it.checked === null ? undefined : "chat-task"}>
                {item(it, `${key}-${i}`, adapter)}
              </li>
            ))}
          </Tag>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{blocks(b.blocks, key, adapter)}</blockquote>;
      case "hr":
        return <hr key={key} />;
    }
  });
}


export function renderMarkdown(text: string, adapter: MarkdownAdapters): ReactNode {
  return blocks(parseBlocks(text), "b", adapter);
}
