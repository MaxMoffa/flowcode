import type { ChatItem } from "../../src/chat/chatModel";
import { formatElapsedLong } from "../../src/chat/goalView";
import { GoalIcon } from "./ChatGoal";
import { t } from "./i18n";

type GoalItem = Extract<ChatItem, { type: "goal" }>;

/** Marks where the goal ended: reached, or given up as impossible. */
export function ChatGoalMarker({ item }: { item: GoalItem }) {
  const failed = item.status === "failed";
  const parts: string[] = [];
  if (item.durationMs !== undefined) parts.push(t("chatGoalIn", { time: formatElapsedLong(item.durationMs) }));
  if (item.iterations !== undefined && item.iterations > 0) parts.push(t("chatGoalChecks", { n: item.iterations }));
  if (failed && item.reason) parts.push(item.reason);
  return (
    <div className={`chat-goal-marker ${failed ? "is-failed" : "is-complete"}`} role="status">
      <div className="chat-goal-marker-line">
        <div className="chat-goal-marker-body">
          <div className="chat-goal-marker-title">
            <GoalIcon status={item.status} size={15} />
            <b>{t(failed ? "chatGoalTagFailed" : "chatGoalTagComplete")}</b>
          </div>
          <div className="chat-goal-marker-obj">{item.objective}</div>
          {parts.length > 0 && <div className="chat-goal-marker-meta">{parts.join(" · ")}</div>}
        </div>
      </div>
    </div>
  );
}
