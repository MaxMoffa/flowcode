import { memo, useState, type CSSProperties } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { cliName } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { ChatMarkdown } from "./ChatMarkdown";
import { delegateAgentColor } from "./delegateStrip";
import { firstLine, type PeerIn, type PeerOut, type PeerState, type PeerTab } from "./peerMessage";
import { decidePeer, openPeerTab } from "./peerActions";
import "./delegates.css";
import "./peer-message.css";

/** Past this many lines a message's body is folded. */
const FOLD_LINES = 6;

const ARROW_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);

const CHEVRON_ICON = (
  <svg className="chat-dstrip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** The sender's or target's agent, as people say it. */
const agentLabel = (tab: PeerTab) => (tab.agent ? cliName(tab.agent) : "agent");

/** What an incoming card says of its state; `terminal`: a tab's inbox (queued = not read yet). */
export function peerStateText(t: (key: MessageKey, vars?: Record<string, string | number>) => string, state: PeerState, error?: string, terminal = false): string {
  switch (state) {
    case "pending_consent":
      return t("chat.peer.state.pending");
    case "queued":
      return t(terminal ? "chat.peer.state.unread" : "chat.peer.state.queued");
    case "delivered":
      return t("chat.peer.state.delivered");
    case "replied":
      return t("chat.peer.state.replied");
    case "declined":
      return t("chat.peer.state.declined");
    case "expired":
      return t("chat.peer.state.expired");
    default:
      return t("chat.peer.state.failed", { reason: error ?? "?" });
  }
}

/** The word an outgoing strip ends with. */
function outStateText(t: (key: MessageKey, vars?: Record<string, string | number>) => string, out: PeerOut): string {
  if (out.state === "failed" && out.error?.includes("back and forth")) return t("chat.peer.loopStop");
  const keys: Record<PeerState, MessageKey> = {
    pending_consent: "chat.peer.out.waitingApproval",
    queued: "chat.peer.out.queued",
    delivered: "chat.peer.out.delivered",
    replied: "chat.peer.out.replied",
    declined: "chat.peer.out.declined",
    expired: "chat.peer.out.expired",
    failed: "chat.peer.out.failed",
  };
  return t(keys[out.state]);
}

/** A message body: markdown, folded past `FOLD_LINES` lines unless `full`. */
function PeerBody({ text, full }: { text: string; full?: boolean }) {
  const { t } = useI18n();
  const long = text.split("\n").length > FOLD_LINES || text.length > 600;
  const [open, setOpen] = useState(false);
  const folded = long && !open && !full;
  return (
    <>
      <div className={`chat-peer-body${folded ? " is-folded" : ""}`}>
        <ChatMarkdown text={text} />
      </div>
      {long && !full && (
        <button type="button" className="chat-peer-more" onClick={() => setOpen(!open)}>
          {t(open ? "chat.peer.less" : "chat.peer.more")}
        </button>
      )}
    </>
  );
}

/** A message another tab's agent sent this chat: who from (with a way to its tab), the text, where it stands; while it waits
 * for the user, the consent buttons. Accepting changes nothing about this chat's permissions. */
export const PeerMessageCard = memo(function PeerMessageCard({ peer, terminal = false }: { peer: PeerIn; terminal?: boolean }) {
  const { t } = useI18n();
  const pending = peer.state === "pending_consent";
  const agent = agentLabel(peer.from);
  const color = peer.from.agent ? delegateAgentColor(peer.from.agent) : "var(--accent)";
  return (
    <div className={`chat-peer is-${peer.state}`} style={{ "--agent": color } as CSSProperties}>
      <div className="chat-peer-head">
        <span className="chat-dstrip-logo is-row">{peer.from.agent ? agentCliIcon(peer.from.agent) : ARROW_ICON}</span>
        <b className="chat-peer-title">{t(peer.replyTo ? "chat.peer.replyFrom" : "chat.peer.from", { tab: peer.from.label, agent })}</b>
        {peer.hops > 0 && <span className="chat-peer-hops">{t("chat.peer.hops", { count: peer.hops })}</span>}
        {!pending && <span className={`chat-peer-state is-${peer.state}`}>{peerStateText(t, peer.state, peer.error, terminal)}</span>}
        {peer.from.window && peer.from.tabId && (
          <button type="button" className="chat-peer-open" onClick={() => openPeerTab(peer.from)}>
            {t("chat.peer.openTab")}
          </button>
        )}
      </div>
      <PeerBody text={peer.text} full={pending} />
      {pending && (
        <>
          <div className="chat-peer-note">{t(peer.forcedConsent ? "chat.peer.consent.loop" : "chat.peer.consent.note")}</div>
          <div className="chat-peer-actions">
            <button type="button" className="chat-btn is-primary" onClick={() => decidePeer(peer.msgId, "accept")}>
              {t("chat.peer.consent.accept")}
            </button>
            <button type="button" className="chat-btn" onClick={() => decidePeer(peer.msgId, "always")}>
              {t("chat.peer.consent.always")}
            </button>
            <button type="button" className="chat-btn" onClick={() => decidePeer(peer.msgId, "decline")}>
              {t("chat.peer.consent.decline")}
            </button>
          </div>
        </>
      )}
    </div>
  );
});

/** A message this chat's agent sent: one line "→ Message to api · Codex — state", opening to the text and the answer. */
export const PeerOutStrip = memo(function PeerOutStrip({ out }: { out: PeerOut }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const agent = agentLabel(out.to);
  const color = out.to.agent ? delegateAgentColor(out.to.agent) : "var(--accent)";
  const live = out.replyText ? firstLine(out.replyText) : out.error && out.state !== "declined" ? firstLine(out.error) : firstLine(out.text);
  return (
    <div className={`chat-dstrip chat-peer-out is-${out.state}${open ? " is-open" : ""}`} style={{ "--agent": color } as CSSProperties}>
      <button type="button" className="chat-dstrip-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chat-dstrip-swap">{ARROW_ICON}</span>
        <b className="chat-dstrip-label">{t("chat.peer.out", { tab: out.to.label, agent })}</b>
        {out.to.agent && <span className="chat-dstrip-logo is-row">{agentCliIcon(out.to.agent)}</span>}
        <span className={`chat-peer-out-state is-${out.state}`}>{outStateText(t, out)}</span>
        <span className="chat-dstrip-sep" aria-hidden="true">
          —
        </span>
        <span className="chat-dstrip-live">{live}</span>
        {CHEVRON_ICON}
      </button>
      {open && (
        <div className="chat-peer-out-body">
          <PeerBody text={out.text} full />
          {out.error && <div className="chat-peer-out-error">{out.error}</div>}
          {out.replyText && (
            <div className="chat-peer-out-reply">
              <div className="chat-peer-out-reply-label">{t("chat.peer.answer")}</div>
              <PeerBody text={out.replyText} full />
            </div>
          )}
          {out.to.window && out.to.tabId && (
            <button type="button" className="chat-peer-open" onClick={() => openPeerTab(out.to)}>
              {t("chat.peer.openTab")}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
