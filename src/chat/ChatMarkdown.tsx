import { memo, useEffect, useState, type ReactNode } from "react";
import { useOpenLink } from "../terminal/useOpenLink";
import { markdownImageRef, splitLinks } from "./chatLinks";
import { ChatImageView } from "./ChatImage";
import { parseBlocks, parseInline, type Block, type Inline } from "./markdownBlocks";
import { useI18n } from "../i18n";
import { ChatTable } from "./ChatTable";
import { findPaths, parsePathToken } from "../lib/filePaths";
import { ChatPathLink } from "../lib/fileLinks";

type OpenLink = ReturnType<typeof useOpenLink>;

/** A link in the text: opens through the app's own link path (the terminal's, with its "ask first" menu), never by navigating the window. */
function ChatLink({ url, open, children }: { url: string; open: OpenLink; children: ReactNode }) {
  return (
    <a
      className="chat-link"
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault();
        open(e, url);
      }}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  );
}

/** Text with the file paths in it as path links (each one a link only once the disk says it exists). */
function withPaths(text: string, keyBase: string, bare = false): ReactNode[] {
  const matches = findPaths(text, { bare });
  if (matches.length === 0) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  matches.forEach((m, i) => {
    if (m.start > last) out.push(text.slice(last, m.start));
    out.push(
      <ChatPathLink key={`${keyBase}-f${i}`} parsed={m}>
        {text.slice(m.start, m.end)}
      </ChatPathLink>,
    );
    last = m.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Text with its `[text](url)` and bare http(s) urls as links, `[text](path)` as a file link (the label alone when the target isn't a path), and file paths as path links. `label` renders a link's text (so code and bold inside it stay formatted). */
function withLinks(text: string, keyBase: string, open: OpenLink, label: (text: string, key: string) => ReactNode = (text) => text): ReactNode[] {
  return splitLinks(text).flatMap((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.url) {
      return (
        <ChatLink key={key} url={part.url} open={open}>
          {label(part.text, key)}
        </ChatLink>
      );
    }
    if (part.path !== undefined) {
      const parsed = parsePathToken(part.path, { bare: true, bareAny: true, spaces: true });
      return parsed ? (
        <ChatPathLink key={key} parsed={parsed}>
          {label(part.text, key)}
        </ChatPathLink>
      ) : (
        label(part.text, key)
      );
    }
    return withPaths(part.text, key);
  });
}

/** An `inline code` span: agents write paths this way, bare file names (`useChat.ts`) included. */
function codeSpan(code: string, key: string): ReactNode {
  const whole = parsePathToken(code, { bare: true, bareAny: true, spaces: true });
  if (whole) {
    return (
      <ChatPathLink key={key} parsed={whole}>
        <code>{code}</code>
      </ChatPathLink>
    );
  }
  return <code key={key}>{withPaths(code, key, true)}</code>;
}

/** Inline tokens as React nodes: formatting, `code` (paths linked), links, and the text between them with its urls and file paths linked. */
function inline(tokens: Inline[], keyBase: string, open: OpenLink): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyBase}-${i}`;
    switch (tok.type) {
      case "text":
        return withLinks(tok.text, key, open);
      case "code":
        return codeSpan(tok.text, key);
      case "link":
        return withLinks(tok.raw, key, open, (label, k) => inline(parseInline(label), k, open));
      case "image": {
        const ref = markdownImageRef(tok.src);
        return ref ? <ChatImageView key={key} image={{ ...ref, name: tok.alt || undefined }} variant="single" caption={tok.alt || undefined} /> : <span key={key}>{tok.alt}</span>;
      }
      case "strong":
        return <strong key={key}>{inline(tok.children, key, open)}</strong>;
      case "em":
        return <em key={key}>{inline(tok.children, key, open)}</em>;
      case "del":
        return <del key={key}>{inline(tok.children, key, open)}</del>;
    }
  });
}

/** Lines joined with <br />, each through `inline`. */
function lines(rows: string[], keyBase: string, open: OpenLink): ReactNode[] {
  const out: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(parseInline(row), `${keyBase}-${i}`, open));
  });
  return out;
}

/** A fenced block: the language and a Copy button over the code. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useI18n();
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
          title={t("chat.code.copyTitle")}
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? t("chat.table.copied") : t("chat.code.copy")}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A list item's blocks; a task item's checkbox leads its first paragraph. */
function item(it: { checked: boolean | null; blocks: Block[] }, keyBase: string, open: OpenLink): ReactNode {
  if (it.checked === null) return blocks(it.blocks, keyBase, open);
  const box = <input key={`${keyBase}-box`} type="checkbox" checked={it.checked} disabled readOnly />;
  const [first, ...rest] = it.blocks;
  if (first?.type === "paragraph") {
    return [<p key={`${keyBase}-p`}>{[box, ...lines(first.lines, `${keyBase}-p`, open)]}</p>, ...blocks(rest, keyBase, open, 1)];
  }
  return [box, ...blocks(it.blocks, keyBase, open)];
}

function blocks(list: Block[], keyBase: string, open: OpenLink, offset = 0): ReactNode[] {
  return list.map((b, n) => {
    const key = `${keyBase}-${n + offset}`;
    switch (b.type) {
      case "paragraph":
        return <p key={key}>{lines(b.lines, key, open)}</p>;
      case "heading": {
        // Levels 1-3 are three sizes; 4-6 share the small one.
        const Tag = b.level <= 3 ? (`h${b.level + 1}` as "h2" | "h3" | "h4") : "h5";
        return (
          <Tag key={key} className={`chat-h chat-h${Math.min(b.level, 4)}`}>
            {inline(parseInline(b.text), key, open)}
          </Tag>
        );
      }
      case "code":
        return <CodeBlock key={key} lang={b.lang} text={b.text} />;
      case "table":
        return <ChatTable key={key} table={b.table} cell={(text, cellKey) => inline(parseInline(text), `${key}-${cellKey}`, open)} />;
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={key} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, i) => (
              <li key={i} className={it.checked === null ? undefined : "chat-task"}>
                {item(it, `${key}-${i}`, open)}
              </li>
            ))}
          </Tag>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{blocks(b.blocks, key, open)}</blockquote>;
      case "hr":
        return <hr key={key} />;
    }
  });
}

/** The light markdown of an agent's reply, like the phone's: fenced code (with copy), headings, nested bullet, numbered and task lists, quotes, rules, tables, `code`, **bold**, *italic*, ~~strike~~, links and line breaks. Built as React nodes (never as HTML); an unclosed fence, as the agent is still typing it, runs to the end of the text. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const open = useOpenLink();
  return <div className="chat-md">{blocks(parseBlocks(text), "b", open)}</div>;
  // Rebuilt only when the text changed: every other message stays as drawn while one streams.
});
