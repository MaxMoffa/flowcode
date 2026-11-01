import type { ReactNode } from "react";
import { markdownImageRef, splitLinks } from "../../src/chat/chatLinks";
import { renderMarkdown } from "../../shared/Markdown";
import { ChatImageView } from "./ChatImage";
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

/** Markdown with the phone's link sheet and image provider. */
export function ChatMarkdown({ text, onLink }: { text: string; onLink: OnLink }) {
  return <div className="chat-md">{renderMarkdown(text, {
    text: (text, key, label) => withLinks(text, key, onLink, label),
    code: (text, key) => <code key={key}>{text}</code>,
    image: (src, alt, key) => {
      const ref = markdownImageRef(src);
      return ref ? <ChatImageView key={key} image={ref} variant="single" caption={alt || undefined} /> : <span key={key}>{alt}</span>;
    },
    table: (table, cell, key) => <ChatTable key={key} table={table} cell={cell} />,
    copyLabels: { copy: t("chatCodeCopy"), copied: t("chatTableCopied") },
  })}</div>;
}
