import { memo, type ReactNode } from "react";
import { useOpenLink } from "../terminal/useOpenLink";
import { markdownImageRef, splitLinks } from "./chatLinks";
import { ChatImageView } from "./ChatImage";
import { renderMarkdown } from "../../shared/Markdown";
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

/** Markdown with desktop file links and the terminal's external-link menu. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const open = useOpenLink();
  const { t } = useI18n();
  return <div className="chat-md">{renderMarkdown(text, {
    text: (text, key, label) => withLinks(text, key, open, label),
    code: codeSpan,
    image: (src, alt, key) => {
      const ref = markdownImageRef(src);
      return ref ? <ChatImageView key={key} image={{ ...ref, name: alt || undefined }} variant="single" caption={alt || undefined} /> : <span key={key}>{alt}</span>;
    },
    table: (table, cell, key) => <ChatTable key={key} table={table} cell={cell} />,
    copyLabels: { copy: t("chat.code.copy"), copied: t("chat.table.copied"), title: t("chat.code.copyTitle") },
  })}</div>;
});
