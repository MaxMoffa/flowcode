import { useState } from "react";
import type { ChatItem } from "../../src/chat/chatModel";
import { ChatMarkdown } from "./ChatMarkdown";
import { t } from "./i18n";

type CompactionItem = Extract<ChatItem, { type: "compaction" }>;

function CompactionIcon({ status }: { status: string }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (status === "in_progress") {
    return (
      <svg {...common} className="chat-compaction-spin" strokeWidth="2">
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg {...common} strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5v.01" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth="1.8">
      <path d="M4 9h16M4 15h16" />
      <path d="M9 5l3 3 3-3M9 19l3-3 3 3" />
    </svg>
  );
}

/** Where the agent compacted its context (`/compact`, or on its own): a line with a pill and, once done, the summary it kept on tap. */
export function ChatCompaction({ item, onLink }: { item: CompactionItem; onLink: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const { status } = item;
  const done = status === "completed";
  const auto = done && !item.manual;
  const label =
    status === "in_progress"
      ? t("chatCompactRunning")
      : status === "failed"
        ? t("chatCompactFailed")
        : status === "cancelled"
          ? t("chatCompactCancelled")
          : auto
            ? t("chatCompactAuto")
            : t("chatCompactDone");
  const hasSummary = done && item.summary.trim() !== "";
  return (
    <div className={`chat-compaction is-${status}${auto ? " is-auto" : ""}`} role="status">
      <div className="chat-compaction-line">
        <span className="chat-compaction-pill">
          <CompactionIcon status={status} />
          <span>{label}</span>
        </span>
      </div>
      {status === "failed" && item.error && <div className="chat-compaction-error">{item.error}</div>}
      {hasSummary && (
        <button type="button" className="chat-compaction-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t("chatCompactHide") : t("chatCompactShow")}
        </button>
      )}
      {hasSummary && open && (
        <div className="chat-compaction-summary">
          <ChatMarkdown text={item.summary} onLink={onLink} />
        </div>
      )}
    </div>
  );
}
