import { useEffect, useMemo, useState } from "react";
import { previewUrls } from "../../src/chat/chatLinks";
import type { LinkPreview } from "../../shared/remote-types";
import { requestLinkPreview, useLinkPreview } from "./linkPreviews";
import { useRemoteSelector } from "./remote";

/** Cards under one message. */
const PREVIEWS_SHOWN = 3;
/** How long a message's text must stay still before its links are asked for (it is streamed in pieces). */
const SETTLE_MS = 600;

/** The host of a url without a leading "www.". */
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function Card({ preview, url, onLink }: { preview: LinkPreview; url: string; onLink: (url: string) => void }) {
  return (
    <a
      className="chat-link-card"
      href={url}
      onClick={(e) => {
        e.preventDefault();
        onLink(url);
      }}
    >
      {preview.image && <img className="chat-link-image" src={preview.image} alt="" draggable={false} />}
      <div className="chat-link-body">
        <span className="chat-link-site">
          {preview.favicon && <img src={preview.favicon} alt="" width={14} height={14} draggable={false} />}
          <span>{preview.siteName ?? domainOf(preview.finalUrl)}</span>
        </span>
        {preview.title && <span className="chat-link-title">{preview.title}</span>}
        {preview.description && <span className="chat-link-desc">{preview.description}</span>}
      </div>
    </a>
  );
}

/** Skeleton, card or nothing for one link; it is asked for as soon as it shows. */
function LinkPreviewView({ url, onLink }: { url: string; onLink: (url: string) => void }) {
  const entry = useLinkPreview(url);
  useEffect(() => {
    requestLinkPreview(url);
  }, [url]);
  if (entry === undefined || entry === null) return null;
  if (entry === "pending") {
    return (
      <div className="chat-link-card is-loading" aria-hidden="true">
        <div className="chat-link-body">
          <span className="chat-link-skeleton is-site" />
          <span className="chat-link-skeleton is-title" />
          <span className="chat-link-skeleton" />
        </div>
      </div>
    );
  }
  return <Card preview={entry} url={url} onLink={onLink} />;
}

/** Preview cards for the first links of an agent's message, only when the desktop's "Link previews" setting is "always" and that desktop can fetch them (any other value, including the old "onClick", shows nothing). */
export function ChatLinkPreviews({ text, onLink }: { text: string; onLink: (url: string) => void }) {
  const mode = useRemoteSelector((s) => (s.host?.caps.includes("linkPreview") ? s.settings?.linkPreviews : "never"));
  const urls = useMemo(() => (mode === "always" ? previewUrls(text, PREVIEWS_SHOWN) : []), [text, mode]);
  const key = urls.join("\n");
  // Only links the text has stopped changing under: a url still being typed is not asked for.
  const [settled, setSettled] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key ? key.split("\n") : []), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  const shown = settled.filter((u) => urls.includes(u));
  if (shown.length === 0) return null;
  return (
    <div className="chat-link-previews">
      {shown.map((url) => (
        <LinkPreviewView key={url} url={url} onLink={onLink} />
      ))}
    </div>
  );
}
