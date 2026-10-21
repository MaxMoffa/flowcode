import { useEffect, useState } from "react";
import type { ChatItem } from "../../src/chat/chatModel";
import type { ChatPermissionOption } from "../../src/chat/chatTypes";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";

type Permission = Extract<ChatItem, { type: "permission" }>;

const KIND_ORDER: ChatPermissionOption["kind"][] = ["allow_once", "allow_always", "reject_once", "reject_always"];

function label(option: ChatPermissionOption): string {
  switch (option.kind) {
    case "allow_once":
      return t("chatAllow");
    case "allow_always":
      return t("chatAllowAlways");
    case "reject_once":
      return t("chatDeny");
    case "reject_always":
      return t("chatDenyAlways");
    default:
      return option.name;
  }
}

/** The agent's open permission request, with big buttons mapped from the options it offered. Drawn by the app, never by a plugin view: nothing a view can send answers it. */
export function PermissionBar({ pending, onAnswer }: { pending: Permission[]; onAnswer: (requestId: string, optionId: string | null) => void }) {
  const first = pending[0];
  /** The request just answered, until the desktop confirms it (the buttons stay put but dead). */
  const [answered, setAnswered] = useState<string | null>(null);
  useEffect(() => setAnswered(null), [first?.requestId]);
  if (!first) return null;

  const options = [...first.options].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const where = first.toolCall.locations?.[0]?.path ?? first.toolCall.content?.find((c) => c.type === "diff")?.path;
  const answer = (optionId: string) => {
    if (answered) return;
    tapFeedback();
    setAnswered(first.requestId);
    onAnswer(first.requestId, optionId);
  };
  return (
    <div className="chat-perm" role="group" aria-label={t("chatPermTitle")}>
      <div className="chat-perm-head">
        <span className="chat-perm-eyebrow">{t("chatPermTitle")}</span>
        {pending.length > 1 && <span className="chat-perm-more">{t("chatPermMore", { n: pending.length - 1 })}</span>}
      </div>
      <div className="chat-perm-title">{first.toolCall.title ?? first.toolCall.kind ?? t("chatPermTitle")}</div>
      {where && <div className="chat-perm-where mono">{where}</div>}
      <div className="chat-perm-options">
        {options.map((o) => (
          <button key={o.optionId} type="button" className={"btn big chat-perm-btn" + (o.kind === "allow_once" ? " accent" : o.kind.startsWith("reject") ? " deny" : "")} disabled={answered !== null} onClick={() => answer(o.optionId)}>
            {label(o)}
          </button>
        ))}
      </div>
    </div>
  );
}
