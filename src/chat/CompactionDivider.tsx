import { useState } from "react";
import { useI18n } from "../i18n";
import type { ChatItem } from "./chatModel";
import { ChatMarkdown } from "./ChatMarkdown";
import "./compaction.css";

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

/** Marks where the agent compacted its context: a line with a pill, and (once done) the summary it kept, on demand. */
export function CompactionDivider({ item }: { item: CompactionItem }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const { status } = item;
  const done = status === "completed";
  const auto = done && !item.manual;
  const label =
    status === "in_progress"
      ? t("chat.compaction.running")
      : status === "failed"
        ? t("chat.compaction.failed")
        : status === "cancelled"
          ? t("chat.compaction.cancelled")
          : auto
            ? t("chat.compaction.auto")
            : t("chat.compaction.done");
  const time = new Date(item.at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const meta = done ? time : status === "failed" ? item.error : "";
  const hasSummary = done && item.summary.trim() !== "";
  return (
    <div className={`chat-compaction is-${status}${auto ? " is-auto" : ""}`} data-compacted={done || undefined} role="status">
      <div className="chat-compaction-line">
        <span className="chat-compaction-pill">
          <CompactionIcon status={status} />
          <span>{label}</span>
          {meta && <span className="chat-compaction-meta">· {meta}</span>}
          {hasSummary && (
            <button type="button" className="chat-compaction-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? t("chat.compaction.hide") : t("chat.compaction.show")}
            </button>
          )}
        </span>
      </div>
      {hasSummary && open && (
        <div className="chat-compaction-summary">
          <ChatMarkdown text={item.summary} />
        </div>
      )}
    </div>
  );
}
