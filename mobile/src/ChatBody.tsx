import { memo, useMemo, useState, type ReactNode } from "react";
import { lineDiff, stopKind, toolImages, type ChatItem, type StopKind } from "../../src/chat/chatModel";
import { hiddenGuardian, nestSubagents, subagentInfo, subagentItems, subagentPrompt, subagentReport, subagentState, type SubagentItem } from "../../src/chat/chatTimeline";
import type { ChatImageRef, ChatPlanEntry, ChatToolCall, ChatToolContent } from "../../src/chat/chatTypes";
import { ChatCompaction } from "./ChatCompaction";
import { ChatImages, ChatUserImages } from "./ChatImage";
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
function summaryOf(calls: ChatToolCall[], withFailed = true): string {
  const counts = new Map<Category, number>();
  for (const call of calls) counts.set(categoryOf(call), (counts.get(categoryOf(call)) ?? 0) + 1);
  const parts = CATEGORY_ORDER.flatMap((c) => {
    const n = counts.get(c);
    return n ? [t(SUMMARY[c][n === 1 ? 0 : 1], { n })] : [];
  });
  const failed = withFailed ? calls.filter((c) => c.status === "failed").length : 0;
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
  const images = toolImages(call);
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
      {images.length > 0 && (
        <div className="chat-step-media">
          <ChatImages images={images} />
        </div>
      )}
    </div>
  );
}

/** The images the tools of a folded run produced: they stay visible without opening the steps. */
function ToolRunImages({ calls }: { calls: ChatToolCall[] }) {
  const images = calls.flatMap((c) => toolImages(c));
  return images.length > 0 ? (
    <div className="chat-step-media">
      <ChatImages images={images} />
    </div>
  ) : null;
}

/** A run of the agent's tool calls on a thin rail, always folded to one row: the step count + the latest step while running, the summary once done; tap opens the numbered steps. Redrawn only when one of its calls changed (the model replaces just the changed ones). */
const ToolRun = memo(function ToolRun({ calls }: { calls: ChatToolCall[] }) {
  const live = calls.some((c) => !isFinished(c));
  const [open, setOpen] = useState(false);
  const failed = calls.some((c) => c.status === "failed");
  const last = calls[calls.length - 1];
  return (
    <div className={"chat-tools" + (open ? " is-open" : "")}>
      <button type="button" className="chat-step-row chat-sum chat-tools-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDownIcon />
        <span className="chat-sum-count">{calls.length}</span>
        {live ? (
          <span className="chat-spinner" aria-hidden="true" />
        ) : (
          <i className={"chat-tools-status" + (failed ? " is-failed" : "")} aria-hidden="true" />
        )}
        <span key={live ? last.toolCallId : "summary"} className={"chat-sum-text" + (live ? " is-live" : "")}>
          {live ? (last.title ?? last.kind ?? last.toolCallId) : summaryOf(calls)}
        </span>
      </button>
      {!open && <ToolRunImages calls={calls} />}
      {open && <div className="chat-tools-list">{calls.map((c, i) => <ToolStep key={c.toolCallId} call={c} index={i + 1} />)}</div>}
    </div>
  );
}, (a, b) => a.calls.length === b.calls.length && a.calls.every((c, i) => c === b.calls[i]));

const BOT_ICON = (
  <svg className="chat-sub-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9 16.5h6" />
  </svg>
);

const OPEN_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

/** The small "open its chat" button of a subagent (over its card, and in the detail under the cards). */
function OpenSubagentButton({ id, onOpen, floating }: { id: string; onOpen: (id: string) => void; floating?: boolean }) {
  return (
    <button type="button" className={"chat-subcard-open" + (floating ? " is-floating" : "")} aria-label={t("chatSubOpen")} onClick={() => onOpen(id)}>
      {OPEN_ICON}
    </button>
  );
}

/** One subagent as a card: its task, type, step count and time, the step in progress (a summary and a tick once done) and a progress bar. Tap selects it; the open-chat button sits over the card, not inside it. */
function SubagentCard({ item, selected, onToggle, onOpen }: { item: SubagentItem; selected: boolean; onToggle: () => void; onOpen?: (id: string) => void }) {
  const { type, description } = subagentInfo(item.call);
  const state = subagentState(item);
  const calls = item.steps.map((s) => s.call);
  const last = calls[calls.length - 1];
  const bad = state.failed || (state.running && last?.status === "failed");
  const percent = state.running ? Math.min(92, 12 + calls.length * 17) : 100;
  const recovered = !state.failed && state.failedSteps > 0 ? t(state.failedSteps === 1 ? "chatSubRecovered1" : "chatSubRecoveredN", { n: state.failedSteps }) : "";
  const liveTitle = state.current ? (state.current.title ?? state.current.kind ?? state.current.toolCallId) : t("chatSubStarting");
  return (
    <div className="chat-subcard-wrap">
      <button type="button" className={"chat-subcard" + (selected ? " is-selected" : "")} aria-expanded={selected} onClick={onToggle}>
        <span className={"chat-subcard-row" + (onOpen ? " has-open" : "")}>
          {BOT_ICON}
          <span className="chat-subcard-name">{description}</span>
        </span>
        <span className="chat-subcard-row">
          {type && <span className="chat-sub-tag">{type}</span>}
          <span className="chat-subcard-pill">{calls.length}</span>
          <span className="chat-subcard-time">{state.running ? t("chatSubRunning") : state.seconds !== null ? t("chatSubSeconds", { n: state.seconds }) : ""}</span>
        </span>
        <span className="chat-subcard-live">
          {state.running ? (
            <>
              <span className="chat-spinner" aria-hidden="true" />
              <span className="chat-subcard-text is-mono">{liveTitle}</span>
            </>
          ) : (
            <>
              <span className={"chat-sub-mark" + (state.failed ? " is-failed" : "")} title={state.failed ? t("chatSubFailed") : t("chatSubDone")}>
                {state.failed ? "\u2715" : "\u2713"}
              </span>
              <span className="chat-subcard-text">{[summaryOf(calls, false), recovered].filter(Boolean).join(" \u00b7 ")}</span>
            </>
          )}
        </span>
        <span className={"chat-subcard-bar" + (state.running ? " is-running" : "") + (bad ? " is-bad" : "")} aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </span>
      </button>
      {onOpen && <OpenSubagentButton id={item.id} onOpen={onOpen} floating />}
    </div>
  );
}

/** A run of subagents launched together as cards side by side (one alone fills the row); the selected card shows its steps and final report under them. */
const SubagentCards = memo(function SubagentCards({ items, onOpen, onLink }: { items: SubagentItem[]; onOpen?: (id: string) => void; onLink?: (url: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  let detail: ReactNode = null;
  if (selected) {
    const { type, description } = subagentInfo(selected.call);
    const state = subagentState(selected);
    const report = subagentReport(selected.call);
    const recovered = !state.failed && state.failedSteps > 0 ? t(state.failedSteps === 1 ? "chatSubRecovered1" : "chatSubRecoveredN", { n: state.failedSteps }) : "";
    detail = (
      <div className="chat-subcards-detail">
        <div className="chat-subcards-detail-head">
          {type && <span className="chat-sub-tag">{type}</span>}
          <b>{description}</b>
          {recovered && <span className="chat-subcards-detail-note">{recovered}</span>}
          {onOpen && <OpenSubagentButton id={selected.id} onOpen={onOpen} />}
          <button type="button" className="chat-subcard-open" aria-label={t("chatSubClose")} onClick={() => setSelectedId(null)}>
            {"\u00d7"}
          </button>
        </div>
        {selected.steps.map((s, i) => (
          <ToolStep key={s.call.toolCallId} call={s.call} index={i + 1} />
        ))}
        {report && (
          <div className="chat-subcards-report">
            <span className="chat-subcards-report-label">{t("chatSubReport")}</span>
            <ChatMarkdown text={report} onLink={onLink ?? (() => {})} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="chat-subcards">
      <div className={"chat-subcards-grid" + (items.length === 1 ? " is-single" : "")}>
        {items.map((item) => (
          <SubagentCard key={item.id} item={item} selected={item.id === selectedId} onToggle={() => setSelectedId(item.id === selectedId ? null : item.id)} onOpen={onOpen} />
        ))}
      </div>
      {detail}
    </div>
  );
}, (a, b) => a.onOpen === b.onOpen && a.onLink === b.onLink && a.items.length === b.items.length && a.items.every((x, i) => x.call === b.items[i].call && x.steps.length === b.items[i].steps.length && x.steps.every((st, j) => st === b.items[i].steps[j])));

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
const AgentText = memo(function AgentText({ text, images, onLink }: { text: string; images?: ChatImageRef[]; onLink: (url: string) => void }) {
  return (
    <div className="chat-agent">
      {text && <ChatMarkdown text={text} onLink={onLink} />}
      {text && <ChatLinkPreviews text={text} onLink={onLink} />}
      {images && images.length > 0 && <ChatImages images={images} />}
    </div>
  );
});

/** One item; redrawn only when it changed (the model keeps the object of an unchanged item). */
const Item = memo(function Item({ item, onLink }: { item: ChatItem; onLink: (url: string) => void }) {
  switch (item.type) {
    case "user":
      return (
        <>
          {item.images && item.images.length > 0 && <ChatUserImages images={item.images} />}
          {(item.text || !item.images?.length) && <div className="chat-user">{item.text}</div>}
        </>
      );
    case "agent":
      return <AgentText text={item.text} images={item.images} onLink={onLink} />;
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
    case "compaction":
      return <ChatCompaction item={item} onLink={onLink} />;
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
function Turn({ group: flat, onLink, onOpenSubagent }: { group: ChatItem[]; onLink: (url: string) => void; onOpenSubagent?: (id: string) => void }) {
  const out: ReactNode[] = [];
  // A subagent's tool calls fold into its own row, apart from the agent's run of calls.
  const group = nestSubagents(flat.filter((i) => !hiddenGuardian(i)));
  for (let i = 0; i < group.length; i++) {
    const item = group[i];
    if (item.type === "subagent") {
      // Subagents launched together (nothing between them) are one block of cards.
      const subs: SubagentItem[] = [item];
      while (i + 1 < group.length) {
        const next = group[i + 1];
        if (next.type !== "subagent") break;
        subs.push(next);
        i++;
      }
      out.push(<SubagentCards key={item.id} items={subs} onOpen={onOpenSubagent} onLink={onLink} />);
      continue;
    }
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
export const ChatBody = memo(function ChatBody({ items, plan, onLink, onOpenSubagent }: { items: ChatItem[]; plan: ChatPlanEntry[] | null; onLink: (url: string) => void; onOpenSubagent?: (id: string) => void }) {
  const groups: ChatItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && item.type !== "user" && last[0].type !== "user") last.push(item);
    else groups.push([item]);
  }
  return (
    <>
      {groups.map((group) => (group[0].type === "user" ? <Item key={group[0].id} item={group[0]} onLink={onLink} /> : <Turn key={group[0].id} group={group} onLink={onLink} onOpenSubagent={onOpenSubagent} />))}
      {plan && plan.length > 0 && <PlanCard plan={plan} />}
    </>
  );
});

/** An open subagent's own chat: the task it was given as a bubble from the main agent, then its messages and tool runs, then its final report. */
export const SubagentBody = memo(function SubagentBody({ sub, agent, onLink, onOpenSubagent }: { sub: SubagentItem; agent: string; onLink: (url: string) => void; onOpenSubagent?: (id: string) => void }) {
  const prompt = subagentPrompt(sub.call);
  const items = subagentItems(sub);
  return (
    <>
      <div className="chat-user is-task">
        <span className="chat-task-label">{t("chatSubTask", { agent })}</span>
        {prompt ? <ChatMarkdown text={prompt} onLink={onLink} /> : sub.call.title}
      </div>
      {items.length > 0 && <Turn group={items} onLink={onLink} onOpenSubagent={onOpenSubagent} />}
    </>
  );
});
