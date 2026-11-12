import { useCallback, useEffect, useRef, useState } from "react";
import { goalEnded, type ChatGoal as Goal, type ChatItem, type GoalAction, type GoalStatus } from "../../src/chat/chatModel";
import { formatElapsed, formatElapsedLong, goalElapsedMs, goalKey, shouldShowGoal } from "../../src/chat/goalView";
import { useBackHandler, useEscape } from "./back";
import { tapFeedback } from "./haptics";
import { t, type Key } from "./i18n";
import { useSupports } from "./remote";

/** Open/closed per chat (starts closed) and the ended goals the user closed, for as long as the app runs. */
const openByChat = new Map<string, boolean>();
const dismissedByChat = new Map<string, string>();

const CHIP_KEY: Record<GoalStatus, Key> = {
  active: "chatGoalChipActive",
  paused: "chatGoalChipPaused",
  limited: "chatGoalChipLimited",
  blocked: "chatGoalChipBlocked",
  complete: "chatGoalChipComplete",
  failed: "chatGoalChipFailed",
};
const TAG_KEY: Record<GoalStatus, Key> = {
  active: "chatGoalTagActive",
  paused: "chatGoalTagPaused",
  limited: "chatGoalTagLimited",
  blocked: "chatGoalTagBlocked",
  complete: "chatGoalTagComplete",
  failed: "chatGoalTagFailed",
};

/** The tone a status is drawn in. */
function goalTone(status: GoalStatus): "ok" | "warn" | "bad" {
  return status === "failed" ? "bad" : status === "paused" || status === "limited" || status === "blocked" ? "warn" : "ok";
}

export function GoalIcon({ status, size = 13 }: { status: GoalStatus; size?: number }) {
  const common = { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (status === "complete")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8 12.5 2.8 2.8L16.5 9.5" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  if (status === "active")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M9 6v12M15 6v12" />
    </svg>
  );
}

interface Props {
  chatId: string;
  goal: Goal;
  actions: GoalAction[];
  items: ChatItem[];
  onAction?: (action: GoalAction) => Promise<void> | void;
  /** Reports whether the chip is showing collapsed (the text field then leaves room for it). */
  onChipChange?: (collapsedChip: boolean) => void;
}

/** The chat's goal: a chip at the composer card's top right that opens, inside the card, into the goal and its controls. */
export function ChatGoal({ chatId, goal, actions, items, onAction, onChipChange }: Props) {
  const supported = useSupports("chatGoal");
  const [open, setOpenState] = useState(() => openByChat.get(chatId) ?? false);
  const [dismissed, setDismissed] = useState<string | null>(() => dismissedByChat.get(chatId) ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  const setOpen = useCallback(
    (value: boolean) => {
      openByChat.set(chatId, value);
      setOpenState(value);
    },
    [chatId],
  );

  const visible = shouldShowGoal(goal, items, dismissed);
  const { status } = goal;
  const active = status === "active";
  const ended = goalEnded(goal);
  const isOpen = open && visible;
  const close = () => setOpen(false);

  useEscape(isOpen, close);
  useBackHandler(isOpen, close);

  useEffect(() => {
    onChipChange?.(visible && !open);
  }, [visible, open, onChipChange]);
  useEffect(() => () => onChipChange?.(false), [onChipChange]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    setNow(Date.now());
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  // A different state of the goal starts without a pending confirmation.
  useEffect(() => {
    setConfirming(false);
    window.clearTimeout(confirmTimer.current);
  }, [status, open]);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      const composer = rootRef.current?.closest(".chat-composer");
      if (composer && e.target && composer.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [isOpen, setOpen]);

  if (!visible) return null;

  const elapsed = goalElapsedMs(goal, now);
  const tone = goalTone(status);
  const can = (a: GoalAction) => supported && !!onAction && actions.includes(a);

  const run = (action: GoalAction) => {
    if (!onAction || busy) return;
    setBusy(true);
    void Promise.resolve(onAction(action)).finally(() => setBusy(false));
  };
  const stop = () => {
    tapFeedback();
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    run("clear");
  };
  const dismiss = () => {
    tapFeedback();
    const key = goalKey(goal);
    dismissedByChat.set(chatId, key);
    setDismissed(key);
    setOpen(false);
  };

  const metaParts: string[] = [];
  if (elapsed !== null) metaParts.push(formatElapsedLong(elapsed));
  if (goal.iterations !== null && goal.iterations > 0) metaParts.push(t("chatGoalChecks", { n: goal.iterations }));
  const meta = metaParts.join(" · ");

  if (!open) {
    return (
      <div ref={rootRef} className="chat-goal-chip-slot" data-tone={tone} data-status={status}>
        <button
          type="button"
          className="chat-goal-chip"
          aria-expanded={false}
          aria-label={t("chatGoalChipLabel", { objective: goal.objective })}
          onClick={() => {
            tapFeedback();
            setOpen(true);
          }}
        >
          <span className="chat-goal-ico">
            <GoalIcon status={status} />
          </span>
          <span className="chat-goal-chip-word">{t(CHIP_KEY[status])}</span>
          {active && elapsed !== null && <span className="chat-goal-chip-time">{formatElapsed(elapsed)}</span>}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="chat-goal-panel" role="region" aria-label={t("chatGoalPanelLabel")} data-tone={tone} data-status={status}>
      <div className="chat-goal-head">
        <span className="chat-goal-ico">
          <GoalIcon status={status} size={14} />
        </span>
        <span className="chat-goal-tag">{t(TAG_KEY[status])}</span>
        {meta && <span className="chat-goal-meta">· {meta}</span>}
        <button
          type="button"
          className="chat-goal-collapse"
          aria-label={t("chatGoalCollapse")}
          onClick={() => {
            tapFeedback();
            setOpen(false);
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
      </div>
      <div className="chat-goal-text">{goal.objective}</div>
      {goal.reason && (
        <div className="chat-goal-reason">
          {active ? t("chatGoalLastCheck") : ""}
          {goal.reason}
        </div>
      )}
      <div className="chat-goal-actions">
        {ended ? (
          <button type="button" className="chat-goal-btn is-ghost" onClick={dismiss}>
            {t("chatGoalClose")}
          </button>
        ) : (
          <>
            {active && can("pause") && (
              <button
                type="button"
                className="chat-goal-btn is-ghost"
                disabled={busy}
                onClick={() => {
                  tapFeedback();
                  run("pause");
                }}
              >
                {t("chatGoalPause")}
              </button>
            )}
            {!active && can("resume") && (
              <button
                type="button"
                className="chat-goal-btn is-main"
                disabled={busy}
                onClick={() => {
                  tapFeedback();
                  run("resume");
                }}
              >
                {t("chatGoalResume")}
              </button>
            )}
            {can("clear") && (
              <button type="button" className={`chat-goal-btn is-danger${confirming ? " is-confirm" : ""}`} disabled={busy} onClick={stop}>
                {confirming ? t("chatGoalConfirmStop") : t("chatGoalStop")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
