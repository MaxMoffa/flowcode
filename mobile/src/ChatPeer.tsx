import { useState, type CSSProperties } from "react";
import { delegateAgentColor } from "../../src/chat/delegateStrip";
import { firstLine, type PeerIn, type PeerOut, type PeerState, type PeerTab } from "../../src/chat/peerMessage";
import { ChatMarkdown } from "./ChatMarkdown";
import { decidePeerMessage } from "./chats";
import { agentName } from "./common";
import { t, type Key } from "./i18n";
import { AgentLogo } from "./icons";
import { showToast } from "./remote";

const IN_STATE: Record<PeerState, Key> = {
  pending_consent: "chatPeerStatePending",
  queued: "chatPeerStateQueued",
  delivered: "chatPeerStateDelivered",
  replied: "chatPeerStateReplied",
  declined: "chatPeerStateDeclined",
  expired: "chatPeerStateExpired",
  failed: "chatPeerStateFailed",
};

const OUT_STATE: Record<PeerState, Key> = {
  pending_consent: "chatPeerOutPending",
  queued: "chatPeerOutQueued",
  delivered: "chatPeerOutDelivered",
  replied: "chatPeerOutReplied",
  declined: "chatPeerOutDeclined",
  expired: "chatPeerOutExpired",
  failed: "chatPeerOutFailed",
};

const ARROW_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);

const CHEV_ICON = (
  <svg className="chat-dstrip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const agentOf = (tab: PeerTab) => (tab.agent ? agentName(tab.agent) : "agent");
const colorOf = (tab: PeerTab) => (tab.agent ? delegateAgentColor(tab.agent) : "var(--accent)");

/** What an incoming card says of its state; `terminal`: a tab's inbox (queued = not read yet). */
export function peerStateLine(peer: PeerIn, terminal = false): string {
  if (peer.state === "queued" && terminal) return t("chatPeerStateUnread");
  return t(IN_STATE[peer.state], { reason: peer.error ?? "?" });
}

/** A message body, folded past a few lines. */
function PeerText({ text, onLink, full }: { text: string; onLink: (url: string) => void; full?: boolean }) {
  const long = text.split("\n").length > 6 || text.length > 500;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={"chat-peer-body" + (long && !open && !full ? " is-folded" : "")}>
        <ChatMarkdown text={text} onLink={onLink} />
      </div>
      {long && !full && (
        <button type="button" className="chat-peer-more" onClick={() => setOpen(!open)}>
          {t(open ? "chatPeerLess" : "chatPeerMore")}
        </button>
      )}
    </>
  );
}

/** A message another tab's agent sent: who from, the text, where it stands; while it waits, the consent buttons (answered on the desktop through `peerdecide`). */
export function ChatPeerCard({ peer, onLink, terminal = false, canDecide = true }: { peer: PeerIn; onLink: (url: string) => void; terminal?: boolean; canDecide?: boolean }) {
  const [sending, setSending] = useState(false);
  const pending = peer.state === "pending_consent";
  const decide = (decision: "accept" | "always" | "decline") => {
    setSending(true);
    void decidePeerMessage(peer.msgId, decision).then((ok) => {
      setSending(false);
      if (!ok) showToast(t("chatPeerSendFailed"));
    });
  };
  return (
    <div className={`chat-peer is-${peer.state}`} style={{ "--agent": colorOf(peer.from) } as CSSProperties}>
      <div className="chat-peer-head">
        <span className="chat-peer-logo">{peer.from.agent ? <AgentLogo cli={peer.from.agent} size={16} /> : ARROW_ICON}</span>
        <b className="chat-peer-title">{t(peer.replyTo ? "chatPeerReplyFrom" : "chatPeerFrom", { tab: peer.from.label, agent: agentOf(peer.from) })}</b>
        {peer.hops > 0 && <span className="chat-peer-hops">{t("chatPeerHops", { count: peer.hops })}</span>}
      </div>
      <PeerText text={peer.text} onLink={onLink} full={pending} />
      <div className={`chat-peer-state is-${peer.state}`}>{peerStateLine(peer, terminal)}</div>
      {pending && canDecide && (
        <>
          <div className="chat-peer-note">{t(peer.forcedConsent ? "chatPeerLoopNote" : "chatPeerNote")}</div>
          <div className="chat-peer-actions">
            <button type="button" className="chat-perm-btn is-primary" disabled={sending} onClick={() => decide("accept")}>
              {t("chatPeerAccept")}
            </button>
            <button type="button" className="chat-perm-btn" disabled={sending} onClick={() => decide("always")}>
              {t("chatPeerAlways")}
            </button>
            <button type="button" className="chat-perm-btn" disabled={sending} onClick={() => decide("decline")}>
              {t("chatPeerDecline")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A message this chat's agent sent: one line, tapping opens the text and the answer. Same look as the delegate strip. */
export function ChatPeerOut({ out, onLink }: { out: PeerOut; onLink: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const state = out.state === "failed" && out.error?.includes("back and forth") ? t("chatPeerLoopStop") : t(OUT_STATE[out.state]);
  const live = out.replyText ? firstLine(out.replyText) : firstLine(out.text);
  return (
    <div className={`chat-dstrip chat-peer-out is-${out.state}${open ? " is-open" : ""}`} style={{ "--agent": colorOf(out.to) } as CSSProperties}>
      <button type="button" className="chat-dstrip-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chat-dstrip-swap">{ARROW_ICON}</span>
        <b>{t("chatPeerOut", { tab: out.to.label, agent: agentOf(out.to) })}</b>
        <span className={`chat-peer-out-state is-${out.state}`}>{state}</span>
        {CHEV_ICON}
      </button>
      {!open && live && <div className="chat-peer-out-live">{live}</div>}
      {open && (
        <div className="chat-peer-out-body">
          <PeerText text={out.text} onLink={onLink} full />
          {out.error && <div className="chat-peer-out-error">{out.error}</div>}
          {out.replyText && (
            <div className="chat-peer-out-reply">
              <div className="chat-peer-out-reply-label">{t("chatPeerAnswer")}</div>
              <PeerText text={out.replyText} onLink={onLink} full />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
