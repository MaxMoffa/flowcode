import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LinkPreview } from "../../shared/remote-types";
import { useI18n } from "../i18n";
import { useOpenLink } from "../terminal/useOpenLink";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { previewUrls } from "./chatLinks";

/** Cards under one message. */
const PREVIEWS_SHOWN = 3;
/** How long a message's text must stay still before its links are fetched (it is streamed in pieces). */
const SETTLE_MS = 600;

/** What the backend found for a url, once per url for the session (the backend caches too); null if nothing. */
const previews = new Map<string, Promise<LinkPreview | null>>();

function fetchPreview(url: string): Promise<LinkPreview | null> {
  let promise = previews.get(url);
  if (!promise) {
    promise = invoke<LinkPreview>("link_preview", { url }).catch(() => null);
    previews.set(url, promise);
  }
  return promise;
}

/** The host of a url without a leading "www.". */
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Skeleton, card or nothing for one url; it is fetched only once `wanted`. */
function usePreview(url: string, wanted: boolean): LinkPreview | "loading" | null {
  const [result, setResult] = useState<LinkPreview | "loading" | null>("loading");
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setResult("loading");
    void fetchPreview(url).then((p) => live && setResult(p));
    return () => {
      live = false;
    };
  }, [url, wanted]);
  return result;
}

function LinkCard({ url, auto }: { url: string; auto: boolean }) {
  const { t } = useI18n();
  const open = useOpenLink();
  const [asked, setAsked] = useState(false);
  const preview = usePreview(url, auto || asked);
  if (!auto && !asked) {
    return (
      <button type="button" className="chat-link-chip" title={url} onClick={() => setAsked(true)}>
        {t("chat.link.show")} · {domainOf(url)}
      </button>
    );
  }
  if (preview === null) return null;
  if (preview === "loading") {
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
  return (
    <a
      className="chat-link-card"
      href={url}
      aria-label={t("chat.link.preview", { url })}
      onClick={(e) => {
        e.preventDefault();
        open(e, url);
      }}
      onAuxClick={(e) => e.preventDefault()}
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

/** Preview cards for the first links of an agent's message, as the "Link previews" setting says. */
export function LinkPreviews({ text }: { text: string }) {
  const { linkPreviews } = useTerminalSettings();
  const urls = useMemo(() => (linkPreviews === "never" ? [] : previewUrls(text, PREVIEWS_SHOWN)), [text, linkPreviews]);
  const key = urls.join("\n");
  // Only links the text has stopped changing under: a url still being typed is not fetched.
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
        <LinkCard key={url} url={url} auto={linkPreviews === "always"} />
      ))}
    </div>
  );
}
