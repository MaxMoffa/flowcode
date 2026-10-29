import { useEffect, useState, type ReactNode } from "react";
import { splitLinks } from "../../src/chat/chatLinks";
import { parseBlocks, parseInline, type Block, type Inline } from "../../src/chat/markdownBlocks";
import { ChatTable } from "./ChatTable";
import { t } from "./i18n";

/** Called with a tapped link. */
type OnLink = (url: string) => void;

/** A link in the text: a tap goes to `onLink` (the sheet or the browser), never navigates the page. */
function Link({ url, onLink, children }: { url: string; onLink: OnLink; children: ReactNode }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        onLink(url);
      }}
    >
      {children}
    </a>
  );
}

/** Text with its `[text](url)` and bare http(s) urls as links. `label` renders a link's text (so code and bold inside it stay formatted); a `[text](path)` shows its label. */
function withLinks(text: string, keyBase: string, onLink: OnLink, label: (text: string, key: string) => ReactNode = (text) => text): ReactNode[] {
  return splitLinks(text).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.url) {
      return (
        <Link key={key} url={part.url} onLink={onLink}>
          {label(part.text, key)}
        </Link>
      );
    }
    return part.path !== undefined ? label(part.text, key) : part.text;
  });
}

/** Inline tokens as React nodes: formatting, `code`, links, and the text between them with its bare urls linked. */
function inline(tokens: Inline[], keyBase: string, onLink: OnLink): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyBase}-${i}`;
    switch (tok.type) {
      case "text":
        return withLinks(tok.text, key, onLink);
      case "code":
        return <code key={key}>{tok.text}</code>;
      case "link":
        return withLinks(tok.raw, key, onLink, (label, k) => inline(parseInline(label), k, onLink));
      case "strong":
        return <strong key={key}>{inline(tok.children, key, onLink)}</strong>;
      case "em":
        return <em key={key}>{inline(tok.children, key, onLink)}</em>;
      case "del":
        return <del key={key}>{inline(tok.children, key, onLink)}</del>;
    }
  });
}

/** Lines joined with <br />, each through `inline`. */
function lines(rows: string[], keyBase: string, onLink: OnLink): ReactNode[] {
  const out: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(parseInline(row), `${keyBase}-${i}`, onLink));
  });
  return out;
}

/** A fenced block: the language and a Copy button over the code. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
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
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? t("chatTableCopied") : t("chatCodeCopy")}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A list item's blocks; a task item's checkbox leads its first paragraph. */
function item(it: { checked: boolean | null; blocks: Block[] }, keyBase: string, onLink: OnLink): ReactNode {
  if (it.checked === null) return blocks(it.blocks, keyBase, onLink);
  const box = <input key={`${keyBase}-box`} type="checkbox" checked={it.checked} disabled readOnly />;
  const [first, ...rest] = it.blocks;
  if (first?.type === "paragraph") {
    return [<p key={`${keyBase}-p`}>{[box, ...lines(first.lines, `${keyBase}-p`, onLink)]}</p>, ...blocks(rest, keyBase, onLink, 1)];
  }
  return [box, ...blocks(it.blocks, keyBase, onLink)];
}

function blocks(list: Block[], keyBase: string, onLink: OnLink, offset = 0): ReactNode[] {
  return list.map((b, n) => {
    const key = `${keyBase}-${n + offset}`;
    switch (b.type) {
      case "paragraph":
        return <p key={key}>{lines(b.lines, key, onLink)}</p>;
      case "heading": {
        // Levels 1-3 are three sizes; 4-6 share the small one.
        const Tag = b.level <= 3 ? (`h${b.level + 1}` as "h2" | "h3" | "h4") : "h5";
        return (
          <Tag key={key} className={`chat-h chat-h${Math.min(b.level, 4)}`}>
            {inline(parseInline(b.text), key, onLink)}
          </Tag>
        );
      }
      case "code":
        return <CodeBlock key={key} lang={b.lang} text={b.text} />;
      case "table":
        return <ChatTable key={key} table={b.table} cell={(text, cellKey) => inline(parseInline(text), `${key}-${cellKey}`, onLink)} />;
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={key} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, i) => (
              <li key={i} className={it.checked === null ? undefined : "chat-task"}>
                {item(it, `${key}-${i}`, onLink)}
              </li>
            ))}
          </Tag>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{blocks(b.blocks, key, onLink)}</blockquote>;
      case "hr":
        return <hr key={key} />;
    }
  });
}

/** The light markdown of an agent's reply, like the desktop chat's: fenced code (with copy), headings, nested bullet, numbered and task lists, quotes, rules, tables, `code`, **bold**, *italic*, ~~strike~~ and links, with single line breaks kept. Built as React nodes (never as HTML); an unclosed fence, as the agent is still typing it, runs to the end. */
export function ChatMarkdown({ text, onLink }: { text: string; onLink: OnLink }) {
  return <div className="chat-md">{blocks(parseBlocks(text), "b", onLink)}</div>;
}
