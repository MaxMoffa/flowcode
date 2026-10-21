import { useMemo } from "react";
import { useI18n } from "../i18n";
import { lineDiff, type ChatItem } from "./chatModel";
import { ChatMarkdown } from "./ChatMarkdown";
import { LinkPreviews } from "./LinkPreviews";
import type { ChatToolCall, ChatToolContent } from "./chatTypes";

/** Diff rows drawn before "… N more lines". */
const DIFF_ROWS_SHOWN = 80;
/** Characters of a tool's text output drawn. */
const TOOL_TEXT_MAX = 4000;

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

function Spinner() {
  return <span className="chat-spinner" aria-hidden="true" />;
}

function ToolStatusIcon({ status }: { status: ChatToolCall["status"] }) {
  if (status === "completed") {
    return (
      <svg className="chat-tool-status is-done" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="5 12.5 10 17.5 19 7" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="chat-tool-status is-failed" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    );
  }
  return <Spinner />;
}

function DiffCard({ diff }: { diff: DiffContent }) {
  const { t } = useI18n();
  const rows = useMemo(() => lineDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText]);
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;
  return (
    <div className="chat-diff">
      <div className="chat-diff-head">
        <span className="chat-diff-path" title={diff.path}>
          <bdi>{diff.path}</bdi>
        </span>
        <span className="chat-diff-count is-add">+{added}</span>
        <span className="chat-diff-count is-del">{"−"}{removed}</span>
      </div>
      <div className="chat-diff-rows">
        {rows.slice(0, DIFF_ROWS_SHOWN).map((row, i) => (
          <div key={i} className={`chat-diff-row is-${row.type}`}>
            <span className="chat-diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
            <span className="chat-diff-text">{row.text}</span>
          </div>
        ))}
        {rows.length > DIFF_ROWS_SHOWN && (
          <div className="chat-diff-more">{t("chat.tool.moreLines", { count: rows.length - DIFF_ROWS_SHOWN })}</div>
        )}
      </div>
    </div>
  );
}

function ToolCall({ call }: { call: ChatToolCall }) {
  const content = call.content ?? [];
  const diffs = content.filter((c): c is DiffContent => c.type === "diff");
  const text = content
    .map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const header = (
    <>
      <ToolStatusIcon status={call.status} />
      <span className="chat-tool-title">{call.title ?? call.kind ?? call.toolCallId}</span>
      {call.kind && <span className="chat-tool-kind">{call.kind}</span>}
    </>
  );
  return (
    <div className="chat-tool">
      {text ? (
        <details>
          <summary className="chat-tool-row">{header}</summary>
          <pre className="chat-tool-output">{text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text}</pre>
        </details>
      ) : (
        <div className="chat-tool-row">{header}</div>
      )}
      {diffs.map((diff, i) => (
        <DiffCard key={i} diff={diff} />
      ))}
    </div>
  );
}

interface ChatItemViewProps {
  item: ChatItem;
  onAnswer: (requestId: string, optionId: string | null) => void;
}

/** One entry of the conversation. */
export function ChatItemView({ item, onAnswer }: ChatItemViewProps) {
  const { t } = useI18n();
  switch (item.type) {
    case "user":
      return <div className="chat-user">{item.text}</div>;
    case "agent":
      return (
        <>
          <ChatMarkdown text={item.text} />
          <LinkPreviews text={item.text} />
        </>
      );
    case "thought":
      return (
        <details className="chat-thought">
          <summary>{t("chat.thought")}</summary>
          <div className="chat-thought-text">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolCall call={item.call} />;
    case "error":
      return (
        <div className="chat-error" role="alert">
          {item.message}
        </div>
      );
    case "permission": {
      const title = item.toolCall.title ?? item.toolCall.kind ?? t("chat.permission.title");
      if (item.resolved !== undefined) {
        const option = item.options.find((o) => o.optionId === item.resolved);
        return (
          <div className="chat-permission-done">
            {option ? t("chat.permission.answered", { option: option.name }) : t("chat.permission.cancelled")}
            {" · "}
            {title}
          </div>
        );
      }
      return (
        <div className="chat-permission" role="group" aria-label={t("chat.permission.title")}>
          <div className="chat-permission-title">{title}</div>
          <div className="chat-permission-options">
            {item.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className={"chat-btn" + (option.kind === "allow_once" ? " is-primary" : "")}
                onClick={() => onAnswer(item.requestId, option.optionId)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      );
    }
  }
}
