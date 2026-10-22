import { memo, useMemo, useState } from "react";
import { lineDiff, type ChatItem } from "../../src/chat/chatModel";
import type { ChatPlanEntry, ChatToolCall, ChatToolContent } from "../../src/chat/chatTypes";
import { ChatLinkPreviews } from "./ChatLinkPreviews";
import { ChatMarkdown } from "./ChatMarkdown";
import { t } from "./i18n";
import { AgentLogo } from "./icons";

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

/** Diff rows shown before "Mostra tutto", and at most after it. */
const DIFF_ROWS_PREVIEW = 6;
const DIFF_ROWS_MAX = 80;
/** Characters of a tool's text output shown. */
const TOOL_TEXT_MAX = 3000;

function ToolStatus({ status }: { status: ChatToolCall["status"] }) {
  if (status === "completed")
    return (
      <svg className="chat-tool-st is-done" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="5 12.5 10 17.5 19 7" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg className="chat-tool-st is-failed" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    );
  return <span className="chat-spinner" aria-hidden="true" />;
}

/** An edit as a small card: the file, +added −removed, and the first rows of the change. */
function DiffCard({ diff }: { diff: DiffContent }) {
  const rows = useMemo(() => lineDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText]);
  const [all, setAll] = useState(false);
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;
  const shown = rows.slice(0, all ? DIFF_ROWS_MAX : DIFF_ROWS_PREVIEW);
  return (
    <div className="chat-diff">
      <div className="chat-diff-head">
        <span className="chat-diff-path mono">
          <bdi>{diff.path}</bdi>
        </span>
        <b className="chat-diff-n is-add">+{added}</b>
        <b className="chat-diff-n is-del">−{removed}</b>
      </div>
      <div className="chat-diff-rows mono">
        {shown.map((row, i) => (
          <div key={i} className={"chat-diff-row is-" + row.type}>
            <span className="chat-diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
            <span className="chat-diff-text">{row.text}</span>
          </div>
        ))}
      </div>
      {!all && rows.length > DIFF_ROWS_PREVIEW && (
        <button type="button" className="chat-diff-more" onClick={() => setAll(true)}>
          {t("chatShowAll")}
        </button>
      )}
      {all && rows.length > DIFF_ROWS_MAX && <div className="chat-diff-more is-static">{t("chatMoreLines", { n: rows.length - DIFF_ROWS_MAX })}</div>}
    </div>
  );
}

function ToolRow({ call }: { call: ChatToolCall }) {
  const content = call.content ?? [];
  const diffs = content.filter((c): c is DiffContent => c.type === "diff");
  const text = content
    .map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const rowClass = "chat-tool-row" + (call.status === "completed" || call.status === "failed" ? "" : " is-running");
  const head = (
    <>
      <ToolStatus status={call.status} />
      <span className="chat-tool-title">{call.title ?? call.kind ?? call.toolCallId}</span>
      {call.kind && <span className="chat-tool-kind">{call.kind}</span>}
    </>
  );
  return (
    <div className="chat-tool">
      {text ? (
        <details>
          <summary className={rowClass}>{head}</summary>
          <pre className="chat-tool-out mono">{text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text}</pre>
        </details>
      ) : (
        <div className={rowClass}>{head}</div>
      )}
      {diffs.map((d, i) => (
        <DiffCard key={i} diff={d} />
      ))}
    </div>
  );
}

function PlanCard({ plan }: { plan: ChatPlanEntry[] }) {
  const done = plan.filter((p) => p.status === "completed").length;
  return (
    <section className="chat-plan" aria-label={t("chatPlan")}>
      <div className="chat-plan-head">
        <b>{t("chatPlan")}</b>
        <span>
          {done}/{plan.length}
        </span>
      </div>
      <ul>
        {plan.map((p, i) => (
          <li key={i} className={"is-" + p.status}>
            <i aria-hidden="true" />
            <span>{p.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What an agent wrote, with a card under it for its first links; rebuilt only when the text grows. */
const AgentText = memo(function AgentText({ text, onLink }: { text: string; onLink: (url: string) => void }) {
  return (
    <div className="chat-agent">
      <ChatMarkdown text={text} onLink={onLink} />
      <ChatLinkPreviews text={text} onLink={onLink} />
    </div>
  );
});

function Item({ item, onLink }: { item: ChatItem; onLink: (url: string) => void }) {
  switch (item.type) {
    case "user":
      return <div className="chat-user">{item.text}</div>;
    case "agent":
      return <AgentText text={item.text} onLink={onLink} />;
    case "thought":
      return (
        <details className="chat-thought">
          <summary>{t("chatThought")}</summary>
          <div>{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow call={item.call} />;
    case "error":
      return (
        <div className="chat-error" role="alert">
          {item.message}
        </div>
      );
    case "permission": {
      // The open request is answered from the bar above the composer; here it only leaves a trace.
      const title = item.toolCall.title ?? item.toolCall.kind ?? t("chatPermTitle");
      const option = item.options.find((o) => o.optionId === item.resolved);
      if (item.resolved === undefined) return <div className="chat-perm-line is-open">{t("chatAsks", { title })}</div>;
      return (
        <div className="chat-perm-line">
          {option ? t("chatPermAnswered", { option: option.name }) : t("chatPermCancelled")} · {title}
        </div>
      );
    }
  }
}

/** The conversation: the user's bubbles, and each run of agent output (text, tools, edits) as one turn under the agent's avatar, then the plan. `onLink` gets a tapped link. */
export const ChatBody = memo(function ChatBody({ items, plan, agent, onLink }: { items: ChatItem[]; plan: ChatPlanEntry[] | null; agent: string; onLink: (url: string) => void }) {
  const groups: ChatItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && item.type !== "user" && last[0].type !== "user") last.push(item);
    else groups.push([item]);
  }
  return (
    <>
      {groups.map((group) =>
        group[0].type === "user" ? (
          <Item key={group[0].id} item={group[0]} onLink={onLink} />
        ) : (
          <div key={group[0].id} className="chat-turn">
            <span className="chat-turn-avatar">
              <AgentLogo cli={agent} size={15} />
            </span>
            <div className="chat-turn-body">
              {group.map((item) => (
                <Item key={item.id} item={item} onLink={onLink} />
              ))}
            </div>
          </div>
        ),
      )}
      {plan && plan.length > 0 && <PlanCard plan={plan} />}
    </>
  );
});
