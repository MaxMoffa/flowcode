import { createContext, useContext, type ReactNode } from "react";
import { markdownImageRef, splitLinks } from "../../src/chat/chatLinks";
import { renderMarkdown } from "../../shared/Markdown";
import { ChatImageView } from "./ChatImage";
import { ChatTable } from "./ChatTable";
import { t } from "./i18n";
import { findPaths, parsePathToken } from "../../src/lib/filePaths";

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

/** Text with the file paths in it that the chat can open (in its folder, previewable) as links. */
function withPaths(text: string, keyBase: string, onLink: OnLink, canOpen: (path: string) => boolean, bare = false): ReactNode[] {
  const matches = findPaths(text, { bare }).filter((m) => canOpen(m.path));
  if (matches.length === 0) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  matches.forEach((m, i) => {
    if (m.start > last) out.push(text.slice(last, m.start));
    out.push(
      <Link key={`${keyBase}-f${i}`} url={m.path} onLink={onLink}>
        {text.slice(m.start, m.end)}
      </Link>,
    );
    last = m.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An `inline code` span: agents write paths this way, so a whole openable path is a link, else the paths inside it are. */
function codeSpan(code: string, key: string, onLink: OnLink, canOpen: (path: string) => boolean): ReactNode {
  const whole = parsePathToken(code, { bare: true, bareAny: true, spaces: true });
  if (whole && canOpen(whole.path)) {
    return (
      <Link key={key} url={whole.path} onLink={onLink}>
        <code>{code}</code>
      </Link>
    );
  }
  return <code key={key}>{withPaths(code, key, onLink, canOpen, true)}</code>;
}

/** Text with its `[text](url)` and bare http(s) urls as links, and the chat's openable file paths too. `label` renders a link's text (so code and bold inside it stay formatted); a `[text](path)` shows its label. */
function withLinks(text: string, keyBase: string, onLink: OnLink, canOpen: (path: string) => boolean, label: (text: string, key: string) => ReactNode = (text) => text): ReactNode[] {
  return splitLinks(text).flatMap((part, i) => {
    const key = `${keyBase}-${i}`;
    const url = part.url ?? (part.path !== undefined && canOpen(part.path) ? part.path : undefined);
    if (url !== undefined) {
      return (
        <Link key={key} url={url} onLink={onLink}>
          {label(part.text, key)}
        </Link>
      );
    }
    return part.path !== undefined ? label(part.text, key) : withPaths(part.text, key, onLink, canOpen);
  });
}

/** Whether a `[text](path)` link can be opened (the chat knows its folder). */
export const ChatFileLinks = createContext<(path: string) => boolean>(() => false);

/** Markdown with the phone's link sheet and image provider. */
export function ChatMarkdown({ text, onLink }: { text: string; onLink: OnLink }) {
  const canOpen = useContext(ChatFileLinks);
  return <div className="chat-md">{renderMarkdown(text, {
    text: (text, key, label) => withLinks(text, key, onLink, canOpen, label),
    code: (text, key) => codeSpan(text, key, onLink, canOpen),
    image: (src, alt, key) => {
      const ref = markdownImageRef(src);
      return ref ? <ChatImageView key={key} image={ref} variant="single" caption={alt || undefined} /> : <span key={key}>{alt}</span>;
    },
    table: (table, cell, key) => <ChatTable key={key} table={table} cell={cell} />,
    copyLabels: { copy: t("chatCodeCopy"), copied: t("chatTableCopied") },
  })}</div>;
}
