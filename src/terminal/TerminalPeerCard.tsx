import { useState } from "react";
import { useI18n } from "../i18n";
import { PeerMessageCard, PeerOutStrip } from "../chat/PeerMessageCard";
import { TERMINAL_READ_HINT } from "../chat/peerMessage";
import { shownTerminalPeers, type TerminalPeers } from "./terminalPeers";
import "../chat/chat.css";
import "./terminalDelegateCard.css";

interface Props {
  peers: TerminalPeers;
  /** Types the read hint into the tab's agent, without Enter: the user sends it. */
  onInsert: () => void;
  onDismiss: () => void;
  hidden?: boolean;
}

/** The messages of a terminal tab, docked top-right over the terminal: what other agents sent (with the consent buttons, or a
 * way to tell the agent to read them - Flowcode never types by itself) and what this tab's agent sent. */
export function TerminalPeerCard({ peers, onInsert, onDismiss, hidden }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const { incoming, outgoing } = shownTerminalPeers(peers);
  if (hidden || (incoming.length === 0 && outgoing.length === 0)) return null;
  const unread = incoming.some((p) => p.state === "queued");
  const copy = () => {
    navigator.clipboard.writeText(TERMINAL_READ_HINT).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  return (
    <div className="term-deleg term-peer">
      <button type="button" className="term-deleg-x" title={t("terminal.peer.dismiss")} aria-label={t("terminal.peer.dismiss")} onClick={onDismiss}>
        ✕
      </button>
      {incoming.map((peer) => (
        <PeerMessageCard key={peer.msgId} peer={peer} terminal />
      ))}
      {unread && (
        <div className="term-peer-actions">
          <button type="button" className="chat-btn" onClick={copy}>
            {copied ? t("terminal.peer.copied") : t("terminal.peer.copyPrompt")}
          </button>
          <button type="button" className="chat-btn is-primary" title={t("terminal.peer.insertHint")} onClick={onInsert}>
            {t("terminal.peer.insertPrompt")}
          </button>
        </div>
      )}
      {outgoing.map((out) => (
        <PeerOutStrip key={out.msgId} out={out} />
      ))}
    </div>
  );
}
