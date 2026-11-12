import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { goalEnded, type ChatGoal, type ChatItem, type GoalAction, type GoalStatus } from "./chatModel";
import { formatElapsed, formatElapsedLong, goalElapsedMs, goalKey, shouldShowGoal } from "./goalView";

/** Open/closed per chat (starts closed) and the ended goals the user closed, for as long as the app runs. */
const openByChat = new Map<string, boolean>();
const dismissedByChat = new Map<string, string>();

const CHIP_KEY: Record<GoalStatus, string> = {
  active: "chat.goal.chipActive",
  paused: "chat.goal.chipPaused",
  limited: "chat.goal.chipLimited",
  blocked: "chat.goal.chipBlocked",
  complete: "chat.goal.chipComplete",
  failed: "chat.goal.chipFailed",
};
const TAG_KEY: Record<GoalStatus, string> = {
  active: "chat.goal.tagActive",
  paused: "chat.goal.tagPaused",
  limited: "chat.goal.tagLimited",
  blocked: "chat.goal.tagBlocked",
  complete: "chat.goal.tagComplete",
  failed: "chat.goal.tagFailed",
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
  goal: ChatGoal;
  actions: GoalAction[];
  items: ChatItem[];
  /** Absent for a chat on another PC: the panel then has no pause/resume/stop. */
  goalAction?: (action: GoalAction) => Promise<void>;
}

/** The chat's goal: a small chip at the composer's top right that opens, inside the composer, into the goal and its controls. */
export function GoalChip({ chatId, goal, actions, items, goalAction }: Props) {
  const { t } = useI18n();
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
    if (!open || !visible) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const composer = rootRef.current?.closest(".chat-composer");
      if (composer && target && composer.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, visible, setOpen]);

  if (!visible) return null;

  const elapsed = goalElapsedMs(goal, now);
  const tone = goalTone(status);
  const label = t(CHIP_KEY[status] as never);
  const tag = t(TAG_KEY[status] as never);
  const can = (a: GoalAction) => !!goalAction && actions.includes(a);

  const run = (action: GoalAction) => {
    if (!goalAction || busy) return;
    setBusy(true);
    void goalAction(action).finally(() => setBusy(false));
  };
  const stop = () => {
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
    const key = goalKey(goal);
    dismissedByChat.set(chatId, key);
    setDismissed(key);
    setOpen(false);
  };

  const metaParts: string[] = [];
  if (elapsed !== null) metaParts.push(formatElapsedLong(elapsed));
  if (goal.iterations !== null && goal.iterations > 0) metaParts.push(t("chat.goal.checks", { n: goal.iterations }));
  const meta = metaParts.join(" · ");

  if (!open) {
    return (
      <div ref={rootRef} className="chat-goal-chip-slot" data-tone={tone} data-status={status}>
        <button type="button" className="chat-goal-chip" aria-expanded={false} aria-label={t("chat.goal.chipLabel", { objective: goal.objective })} title={goal.objective} onClick={() => setOpen(true)}>
          <span className="chat-goal-ico">
            <GoalIcon status={status} />
          </span>
          <span className="chat-goal-chip-word">{label}</span>
          {active && elapsed !== null && <span className="chat-goal-chip-time">{formatElapsed(elapsed)}</span>}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="chat-goal-panel" role="region" aria-label={t("chat.goal.panelLabel")} data-tone={tone} data-status={status}>
      <div className="chat-goal-head">
        <span className="chat-goal-ico">
          <GoalIcon status={status} size={14} />
        </span>
        <span className="chat-goal-tag">{tag}</span>
        {meta && <span className="chat-goal-meta">· {meta}</span>}
        <button type="button" className="chat-goal-collapse" aria-label={t("chat.goal.collapse")} title={t("chat.goal.collapse")} onClick={() => setOpen(false)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
      </div>
      <div className="chat-goal-text">{goal.objective}</div>
      {goal.reason && (
        <div className="chat-goal-reason">
          {active ? t("chat.goal.lastCheck") : ""}
          {goal.reason}
        </div>
      )}
      <div className="chat-goal-actions">
        {ended ? (
          <button type="button" className="chat-goal-btn is-ghost" onClick={dismiss}>
            {t("chat.goal.close")}
          </button>
        ) : (
          <>
            {active && can("pause") && (
              <button type="button" className="chat-goal-btn is-ghost" disabled={busy} onClick={() => run("pause")}>
                {t("chat.goal.pause")}
              </button>
            )}
            {!active && can("resume") && (
              <button type="button" className="chat-goal-btn is-main" disabled={busy} onClick={() => run("resume")}>
                {t("chat.goal.resume")}
              </button>
            )}
            {can("clear") && (
              <button type="button" className={`chat-goal-btn is-danger${confirming ? " is-confirm" : ""}`} disabled={busy} onClick={stop}>
                {confirming ? t("chat.goal.confirmStop") : t("chat.goal.stop")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
