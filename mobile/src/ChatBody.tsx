import { memo, useMemo, useState, type ReactNode } from "react";
import { lineDiff, stopKind, type ChatItem, type StopKind } from "../../src/chat/chatModel";
import type { ChatPlanEntry, ChatToolCall, ChatToolContent } from "../../src/chat/chatTypes";
import { ChatLinkPreviews } from "./ChatLinkPreviews";
import { ChatMarkdown } from "./ChatMarkdown";
import { t, type Key } from "./i18n";
import { ChevronDownIcon } from "./icons";

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

/** Diff rows shown before "Mostra tutto", and at most after it. */
const DIFF_ROWS_PREVIEW = 6;
const DIFF_ROWS_MAX = 80;
/** Characters of a tool's text output shown. */
const TOOL_TEXT_MAX = 3000;

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

const isFinished = (call: ChatToolCall) => call.status === "completed" || call.status === "failed";

type Category = "read" | "search" | "edit" | "run" | "other";

/** The summary words per category: singular and plural. */
const SUMMARY: Record<Category, [Key, Key]> = {
  read: ["chatSumRead1", "chatSumReadN"],
  search: ["chatSumSearch1", "chatSumSearchN"],
  edit: ["chatSumEdit1", "chatSumEditN"],
  run: ["chatSumRun1", "chatSumRunN"],
  other: ["chatSumOther1", "chatSumOtherN"],
};
const CATEGORY_ORDER: Category[] = ["read", "search", "edit", "run", "other"];

function categoryOf(call: ChatToolCall): Category {
  switch (call.kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return "run";
    default:
      return "other";
  }
}

/** "2 file letti · 1 modifica" for a run of finished steps, with the failed ones counted last. */
function summaryOf(calls: ChatToolCall[]): string {
  const counts = new Map<Category, number>();
  for (const call of calls) counts.set(categoryOf(call), (counts.get(categoryOf(call)) ?? 0) + 1);
  const parts = CATEGORY_ORDER.flatMap((c) => {
    const n = counts.get(c);
    return n ? [t(SUMMARY[c][n === 1 ? 0 : 1], { n })] : [];
  });
  const failed = calls.filter((c) => c.status === "failed").length;
  if (failed > 0) parts.push(t(failed === 1 ? "chatSumFailed1" : "chatSumFailedN", { n: failed }));
  return parts.join(" · ");
}

/** One step on the rail: a dot (muted when done, glowing while it runs, red when it failed), what it did, and its output on tap. */
function ToolStep({ call, index }: { call: ChatToolCall; index: number }) {
  const content = call.content ?? [];
  const diffs = content.filter((c): c is DiffContent => c.type === "diff");
  const text = content
    .map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const state = call.status === "failed" ? "is-failed" : call.status === "completed" ? "is-done" : "is-live";
  const head = (
    <>
      <span className="chat-step-num">{index}</span>
      <i className={"chat-dot " + state} aria-hidden="true" />
      <span className="chat-step-title">{call.title ?? call.kind ?? call.toolCallId}</span>
      {state === "is-live" && <span className="chat-spinner" aria-hidden="true" />}
      {state === "is-failed" && <b className="chat-step-failed">{t("chatToolFailed")}</b>}
    </>
  );
  return (
    <div className={"chat-step " + state}>
      {text ? (
        <details>
          <summary className="chat-step-row">{head}</summary>
          <pre className="chat-tool-out mono">{text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text}</pre>
        </details>
      ) : (
        <div className="chat-step-row">{head}</div>
      )}
      {diffs.map((d, i) => (
        <DiffCard key={i} diff={d} />
      ))}
    </div>
  );
}

/** A run of the agent's tool calls on a thin rail, always folded to one row: the step count + the latest step while running, the summary once done; tap opens the numbered steps. Redrawn only when one of its calls changed (the model replaces just the changed ones). */
const ToolRun = memo(function ToolRun({ calls }: { calls: ChatToolCall[] }) {
  const live = calls.some((c) => !isFinished(c));
  const [open, setOpen] = useState(false);
  const failed = calls.some((c) => c.status === "failed");
  const last = calls[calls.length - 1];
  return (
    <div className="chat-rail">
      <button type="button" className="chat-step-row chat-sum" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i className={"chat-dot " + (live ? "is-live" : failed ? "is-failed" : "is-done")} aria-hidden="true" />
        <span className="chat-sum-count">{calls.length}</span>
        <span key={live ? last.toolCallId : "summary"} className={"chat-sum-text" + (live ? " is-live" : "")}>
          {live ? (last.title ?? last.kind ?? last.toolCallId) : summaryOf(calls)}
        </span>
        {live && <span className="chat-spinner" aria-hidden="true" />}
        <ChevronDownIcon />
      </button>
      {open && calls.map((c, i) => <ToolStep key={c.toolCallId} call={c} index={i + 1} />)}
    </div>
  );
}, (a, b) => a.calls.length === b.calls.length && a.calls.every((c, i) => c === b.calls[i]));

/** The words for why a turn stopped early. */
const STOP_TEXT: Record<StopKind, Key> = {
  maxTokens: "chatStopMaxTokens",
  maxTurnRequests: "chatStopMaxTurnRequests",
  refusal: "chatStopRefusal",
  other: "chatStopOther",
};

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

/** One item; redrawn only when it changed (the model keeps the object of an unchanged item). */
const Item = memo(function Item({ item, onLink }: { item: ChatItem; onLink: (url: string) => void }) {
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
      return <ToolRun calls={[item.call]} />;
    case "error":
      return (
        <div className="chat-error" role="alert">
          {item.message}
        </div>
      );
    case "permission": {
      // The open request is answered from the card above the composer; here it only leaves a trace on the rail.
      const title = item.toolCall.title ?? item.toolCall.kind ?? t("chatPermTitle");
      const option = item.options.find((o) => o.optionId === item.resolved);
      const open = item.resolved === undefined;
      return (
        <div className="chat-rail">
          <div className={"chat-step chat-perm-line" + (open ? " is-open" : "")}>
            <div className="chat-step-row">
              <i className={"chat-dot " + (open ? "is-warn" : "is-done")} aria-hidden="true" />
              <span className="chat-step-title">{open ? t("chatAsks", { title }) : `${option ? t("chatPermAnswered", { option: option.name }) : t("chatPermCancelled")} · ${title}`}</span>
            </div>
          </div>
        </div>
      );
    }
    case "stop":
      return (
        <div className="chat-stop" role="status">
          {t(STOP_TEXT[stopKind(item.reason)], { reason: item.reason })}
        </div>
      );
    default:
      // An item kind added by a newer desktop: skipped, never a crash.
      return null;
  }
});

/** A turn's items in order, with each run of consecutive tool calls folded into one rail. */
function Turn({ group, onLink }: { group: ChatItem[]; onLink: (url: string) => void }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < group.length; i++) {
    const item = group[i];
    if (item.type !== "tool") {
      out.push(<Item key={item.id} item={item} onLink={onLink} />);
      continue;
    }
    const calls: ChatToolCall[] = [item.call];
    while (i + 1 < group.length) {
      const next = group[i + 1];
      if (next.type !== "tool") break;
      calls.push(next.call);
      i++;
    }
    out.push(<ToolRun key={item.id} calls={calls} />);
  }
  return <div className="chat-turn">{out}</div>;
}

/** The conversation: the user's small bubbles, and each run of agent output as one turn of plain text with its tool calls on a rail, then the plan. `onLink` gets a tapped link. */
export const ChatBody = memo(function ChatBody({ items, plan, onLink }: { items: ChatItem[]; plan: ChatPlanEntry[] | null; onLink: (url: string) => void }) {
  const groups: ChatItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && item.type !== "user" && last[0].type !== "user") last.push(item);
    else groups.push([item]);
  }
  return (
    <>
      {groups.map((group) => (group[0].type === "user" ? <Item key={group[0].id} item={group[0]} onLink={onLink} /> : <Turn key={group[0].id} group={group} onLink={onLink} />))}
      {plan && plan.length > 0 && <PlanCard plan={plan} />}
    </>
  );
});
