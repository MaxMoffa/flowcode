import type { ReactNode } from "react";
import { splitLinks } from "../../src/chat/chatLinks";
import { readTable } from "../../src/chat/markdownTable";
import { ChatTable } from "./ChatTable";

/** Called with a tapped link. */
type OnLink = (url: string) => void;

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

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

/** `inline code`, **bold** and links inside one line of text. */
function inline(text: string, keyBase: string, onLink: OnLink): ReactNode[] {
  return text.split(/(\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))+\)|`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("[") && part.endsWith(")") && part.includes("](")) return withLinks(part, key, onLink, (label, k) => inline(label, k, onLink));
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{inline(part.slice(2, -2), key, onLink)}</strong>;
    return withLinks(part, key, onLink);
  });
}

/** Lines joined with <br />, each through `inline`. */
function lines(rows: string[], keyBase: string, onLink: OnLink): ReactNode[] {
  const out: ReactNode[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(row, `${keyBase}-${i}`, onLink));
  });
  return out;
}

/** The light markdown of an agent's reply, like the desktop chat's: fenced code, headings, bullet and numbered lists, tables, `code`, **bold** and links, with single line breaks kept. Built as React nodes (never as HTML); an unclosed fence, as the agent is still typing it, runs to the end. */
export function ChatMarkdown({ text, onLink }: { text: string; onLink: OnLink }) {
  const blocks: ReactNode[] = [];
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    const key = blocks.length;
    if (paragraph.length > 0) blocks.push(<p key={`p${key}`}>{lines(paragraph, `p${key}`, onLink)}</p>);
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`l${key}`}>
          {list.items.map((item, i) => (
            <li key={i}>{inline(item, `l${key}-${i}`, onLink)}</li>
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
      blocks.push(<ChatTable key={key} table={table.table} cell={(text, cellKey) => inline(text, `${key}-${cellKey}`, onLink)} />);
      i = table.next - 1;
    } else if (heading) {
      flush();
      blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1], `h${blocks.length}`, onLink)}</h4>);
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
}
