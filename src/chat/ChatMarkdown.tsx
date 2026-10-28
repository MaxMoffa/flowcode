import { memo, type ReactNode } from "react";
import { useOpenLink } from "../terminal/useOpenLink";
import { splitLinks } from "./chatLinks";
import { readTable } from "./markdownTable";
import { ChatTable } from "./ChatTable";
import { findPaths, parsePathToken } from "../lib/filePaths";
import { ChatPathLink } from "../lib/fileLinks";

type OpenLink = ReturnType<typeof useOpenLink>;

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

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

/** `inline code`, **bold** and links inside one line of text. */
function inline(text: string, keyBase: string, open: OpenLink): ReactNode[] {
  return text.split(/(\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))+\)|`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("[") && part.endsWith(")") && part.includes("](")) return withLinks(part, key, open, (label, k) => inline(label, k, open));
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return codeSpan(part.slice(1, -1), key);
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{inline(part.slice(2, -2), key, open)}</strong>;
    return withLinks(part, key, open);
  });
}

/** Lines joined with <br />, each through `inline`. */
function lines(rows: string[], keyBase: string, open: OpenLink): ReactNode[] {
  const out: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(row, `${keyBase}-${i}`, open));
  });
  return out;
}

/** The light markdown of an agent's reply, like the phone's: fenced code, headings, bullet and numbered lists, tables, `code`, **bold**, links and line breaks. Built as React nodes (never as HTML); an unclosed fence, as the agent is still typing it, runs to the end of the text. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const open = useOpenLink();
  const blocks: ReactNode[] = [];
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    const key = blocks.length;
    if (paragraph.length > 0) blocks.push(<p key={`p${key}`}>{lines(paragraph, `p${key}`, open)}</p>);
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`l${key}`}>
          {list.items.map((item, i) => (
            <li key={i}>{inline(item, `l${key}-${i}`, open)}</li>
          ))}
        </Tag>,
      );
    }
    paragraph = [];
    list = null;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fence = FENCE.exec(row);
    const table = !fence && row.includes("|") ? readTable(rows, i) : null;
    const heading = HEADING.exec(row);
    const bullet = BULLET.exec(row);
    const numbered = bullet ? null : ORDERED.exec(row);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < rows.length && !rows[i].trim().startsWith(fence[1]); i++) code.push(rows[i]);
      blocks.push(
        <pre key={`c${blocks.length}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (table) {
      flush();
      const key = `t${blocks.length}`;
      blocks.push(<ChatTable key={key} table={table.table} cell={(text, cellKey) => inline(text, `${key}-${cellKey}`, open)} />);
      i = table.next - 1;
    } else if (heading) {
      flush();
      blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1], `h${blocks.length}`, open)}</h4>);
    } else if (bullet || numbered) {
      // A list item ends the paragraph before it, and a list of the other kind.
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list = list ?? { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (row.trim() === "") {
      flush();
    } else {
      if (list) flush();
      paragraph.push(row);
    }
  }
  flush();
  return <div className="chat-md">{blocks}</div>;
  // Rebuilt only when the text changed: every other message stays as drawn while one streams.
});
