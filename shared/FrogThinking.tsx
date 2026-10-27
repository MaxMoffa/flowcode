// The "agent is working" line of a chat, shared by the desktop and the phone:
// a hopping frog, a verb (or the running tool), then (12s · ↓ 1.2k token · Esc).
// No i18n here: each app passes its own strings.
import { useEffect, useState, type ReactNode } from "react";
import "./frog-thinking.css";

/** How long a verb stays before the next one. */
const VERB_MS = 3200;

/** `45s`, `1m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** Estimated tokens (about 4 characters each): `950`, `1.2k`, `12k`. */
export function formatTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(tokens / 1000)}k`;
}

export interface FrogThinkingProps {
  /** Shown instead of the rotating verbs (e.g. the running tool's title). */
  activity?: string | null;
  /** Playful verbs cycled while nothing more specific is known. */
  verbs: string[];
  /** Turn start (ms since epoch); the elapsed time is counted from it. */
  startedAt?: number | null;
  /** Characters the agent streamed in this turn; shown as estimated tokens (chars / 4). */
  outChars?: number;
  /** e.g. n => `${n} token`. */
  tokensLabel: (formatted: string) => string;
  /** e.g. "Esc per interrompere"; absent on the phone. */
  stopHint?: string;
  /** e.g. "Estimated from the text received" - title on the token count. */
  tokensTitle?: string;
}

export function FrogThinking({ activity, verbs, startedAt, outChars, tokensLabel, stopHint, tokensTitle }: FrogThinkingProps) {
  const [now, setNow] = useState(() => Date.now());
  const [verbIndex, setVerbIndex] = useState(() => Math.floor(Math.random() * Math.max(1, verbs.length)));

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const rotating = !activity && verbs.length > 1;
  useEffect(() => {
    if (!rotating) return;
    const id = setInterval(() => setVerbIndex((i) => i + 1), VERB_MS);
    return () => clearInterval(id);
  }, [rotating]);

  const verb = activity || (verbs.length > 0 ? verbs[verbIndex % verbs.length] : "");
  const parts: ReactNode[] = [];
  if (startedAt) parts.push(<span key="time">{formatElapsed(now - startedAt)}</span>);
  if (outChars && outChars > 0) {
    parts.push(
      <span key="tokens" title={tokensTitle}>
        {"↓ "}
        {tokensLabel(formatTokens(outChars))}
      </span>,
    );
  }
  if (stopHint) parts.push(<span key="stop">{stopHint}</span>);

  return (
    <div className="frog-thinking" role="status">
      <span className="frog-thinking-stage" aria-hidden="true">
        <svg className="frog-thinking-frog" viewBox="130 205 764 650">
          <g className="ft-body">
            <circle cx="340" cy="400" r="135" />
            <circle cx="684" cy="400" r="135" />
            <ellipse cx="512" cy="610" rx="360" ry="220" />
          </g>
          <circle className="ft-eye" cx="340" cy="393" r="85" />
          <circle className="ft-eye" cx="684" cy="393" r="85" />
          <circle className="ft-pupil" cx="362" cy="408" r="45" />
          <circle className="ft-pupil" cx="706" cy="408" r="45" />
          <circle className="ft-lid" cx="340" cy="393" r="88" />
          <circle className="ft-lid" cx="684" cy="393" r="88" />
          <g className="ft-mouth">
            <path d="M396 575 L472 632 L396 689" />
            <path d="M526 689 L636 689" />
          </g>
        </svg>
      </span>
      <span className="frog-thinking-verb">{verb}</span>
      {parts.length > 0 && (
        // Out of the live region: a timer ticking every second would be read out each time.
        <span className="frog-thinking-meta" aria-hidden="true">
          {"("}
          {parts.flatMap((p, i) => (i === 0 ? [p] : [" · ", p]))}
          {")"}
        </span>
      )}
    </div>
  );
}
