import { memo, type ReactNode } from "react";
import { useOpenLink } from "../terminal/useOpenLink";
import { splitLinks } from "./chatLinks";
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

/** Text with its `[text](url)` and bare http(s) urls as links, and file paths as path links. */
function withLinks(text: string, keyBase: string, open: OpenLink): ReactNode[] {
  return splitLinks(text).flatMap((part, i) =>
    part.url ? (
      <ChatLink key={`${keyBase}-${i}`} url={part.url} open={open}>
        {part.text}
      </ChatLink>
    ) : (
      withPaths(part.text, `${keyBase}-${i}`)
    ),
  );
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
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return codeSpan(part.slice(1, -1), key);
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{withLinks(part.slice(2, -2), key, open)}</strong>;
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

/** A light markdown subset - fenced code, `code`, **bold**, links, "- " bullets, line
 * breaks - built as React nodes (never as HTML). An unclosed fence, as the
 * agent is still typing it, runs to the end of the text. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const open = useOpenLink();
  const blocks: ReactNode[] = [];
  const rows = text.split("\n");
  let paragraph: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(<p key={`p${blocks.length}`}>{lines(paragraph, `p${blocks.length}`, open)}</p>);
    if (bullets.length > 0) {
      const key = `u${blocks.length}`;
      blocks.push(
        <ul key={key}>
          {bullets.map((b, i) => (
            <li key={i}>{inline(b, `${key}-${i}`, open)}</li>
          ))}
        </ul>,
      );
    }
    paragraph = [];
    bullets = [];
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < rows.length && !rows[i].trimStart().startsWith("```"); i++) code.push(rows[i]);
      blocks.push(
        <pre key={`c${blocks.length}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (row.startsWith("- ")) {
      // A bullet ends the paragraph before it.
      if (paragraph.length > 0) flush();
      bullets.push(row.slice(2));
    } else if (row.trim() === "") {
      flush();
    } else {
      if (bullets.length > 0) flush();
      paragraph.push(row);
    }
  }
  flush();
  return <div className="chat-md">{blocks}</div>;
  // Rebuilt only when the text changed: every other message stays as drawn while one streams.
});
