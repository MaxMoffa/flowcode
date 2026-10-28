import { memo, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { lineDiff, stopKind, type ChatItem, type StopKind } from "./chatModel";
import { ChatMarkdown } from "./ChatMarkdown";
import { LinkPreviews } from "./LinkPreviews";
import { basename } from "../lib/path";
import { ChatPathLink } from "../lib/fileLinks";
import { STEP_CATEGORIES, subagentInfo, subagentReport, subagentState, summarizeSteps, type SubagentItem, type TimelineStep } from "./chatTimeline";
import type { ChatPermissionOption, ChatToolContent } from "./chatTypes";

/** Diff rows drawn before "… N more lines". */
const DIFF_ROWS_SHOWN = 80;
/** Characters of a tool's text output drawn. */
const TOOL_TEXT_MAX = 4000;

type DiffContent = Extract<ChatToolContent, { type: "diff" }>;

function DiffCard({ diff }: { diff: DiffContent }) {
  const { t } = useI18n();
  const rows = useMemo(() => lineDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText]);
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;
  return (
    <div className="chat-diff">
      <div className="chat-diff-head">
        <span className="chat-diff-path" title={diff.path}>
          <ChatPathLink parsed={{ path: diff.path }}>
            <bdi>{diff.path}</bdi>
          </ChatPathLink>
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

function ToolStep({ step, live, index }: { step: Extract<TimelineStep, { type: "tool" }>; live: boolean; index: number }) {
  const { t } = useI18n();
  const call = step.call;
  const content = call.content ?? [];
  const diffs = content.filter((c): c is DiffContent => c.type === "diff");
  const text = content
    .map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const failed = call.status === "failed";
  const running = live && call.status !== "completed" && !failed;
  const title = call.title ?? call.kind ?? call.toolCallId;
  const file = call.locations?.[0]?.path;
  const fileLine = call.locations?.[0]?.line ?? undefined;
  const fileName = file ? basename(file) : "";
  const header = (
    <>
      <span className="chat-step-num">{index}</span>
      <span className={`chat-dot${running ? " is-live" : failed ? " is-failed" : " is-done"}`} aria-hidden="true" />
      {running && <span className="chat-spinner" aria-hidden="true" />}
      <span className="chat-step-title">{title}</span>
      {fileName && !title.includes(fileName) && (
        <span className="chat-step-file" title={file}>
          <ChatPathLink parsed={{ path: file ?? "", line: fileLine }}>{fileName}</ChatPathLink>
        </span>
      )}
      {failed && <span className="chat-step-failed">{t("chat.tool.failed")}</span>}
    </>
  );
  return (
    <div className={`chat-step${failed ? " is-failed" : ""}`}>
      {text ? (
        <details>
          <summary className="chat-step-row">{header}</summary>
          <pre className="chat-tool-output">{text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text}</pre>
        </details>
      ) : (
        <div className="chat-step-row">{header}</div>
      )}
      {diffs.map((diff, i) => (
        <DiffCard key={i} diff={diff} />
      ))}
    </div>
  );
}

function PermissionStep({ step, index }: { step: Extract<TimelineStep, { type: "permission" }>; index: number }) {
  const { t } = useI18n();
  const title = step.toolCall.title ?? step.toolCall.kind ?? t("chat.permission.title");
  const option = step.options.find((o) => o.optionId === step.resolved);
  return (
    <div className="chat-step">
      <div className="chat-step-row is-quiet">
        <span className="chat-step-num">{index}</span>
        <span className="chat-dot is-done" aria-hidden="true" />
        <span className="chat-step-title">
          {option ? t("chat.permission.answered", { option: option.name }) : t("chat.permission.cancelled")}
          {" · "}
          {title}
        </span>
      </div>
    </div>
  );
}

function summaryText(steps: TimelineStep[], t: ReturnType<typeof useI18n>["t"], withFailed = true): string {
  const { counts, failed: failedCount } = summarizeSteps(steps);
  const failed = withFailed ? failedCount : 0;
  const parts: string[] = STEP_CATEGORIES.filter((c) => counts[c] > 0).map((c) =>
    t(`chat.group.${c}.${counts[c] === 1 ? "one" : "other"}`, { count: counts[c] }),
  );
  if (parts.length === 0) parts.push(t("chat.group.other.other", { count: steps.length }));
  if (failed > 0) parts.push(t(`chat.group.failed.${failed === 1 ? "one" : "other"}`, { count: failed }));
  return parts.join(" · ");
}

/** The tool activity of one agent turn on a thin rail, always folded to one row: the step count, then the latest step while it runs or the summary (counts per kind) once done; it expands to the numbered steps. */
export const ToolGroup = memo(function ToolGroup({ steps, live }: { steps: TimelineStep[]; live: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { failed } = summarizeSteps(steps);
  const last = steps[steps.length - 1];
  const lastTitle =
    last.type === "tool"
      ? (last.call.title ?? last.call.kind ?? last.call.toolCallId)
      : (last.toolCall.title ?? last.toolCall.kind ?? t("chat.permission.title"));
  const summaryClass = live ? "chat-group-summary is-live" : failed > 0 ? "chat-group-summary has-failed" : "chat-group-summary";
  return (
    <div className="chat-rail">
      <button type="button" className="chat-group-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        <span className={`chat-dot${live ? " is-live" : failed > 0 ? " is-failed" : " is-done"}`} aria-hidden="true" />
        <svg className="chat-group-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="chat-group-count">{steps.length}</span>
        {live && <span className="chat-spinner" aria-hidden="true" />}
        <span key={live ? last.id : "summary"} className={summaryClass}>
          {live ? lastTitle : summaryText(steps, t)}
        </span>
      </button>
      {expanded &&
        steps.map((step, i) =>
          step.type === "tool" ? (
            <ToolStep key={step.id} step={step} live={live} index={i + 1} />
          ) : (
            <PermissionStep key={step.id} step={step} index={i + 1} />
          ),
        )}
    </div>
  );
  // The timeline rebuilds its step arrays on every render; the steps themselves keep their identity until they change.
}, (a, b) => a.live === b.live && a.steps.length === b.steps.length && a.steps.every((s, i) => s === b.steps[i]));

const CHEVRON = (
  <svg className="chat-group-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const BOT_ICON = (
  <svg className="chat-sub-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9 16.5h6" />
  </svg>
);

/** One subagent as a folded row in the style of the tool groups: its type and task, how many steps it made and the one in progress (a summary, time and a tick once done); open, its steps indented, then its final report folded. */
export const SubagentRow = memo(function SubagentRow({ item, onOpen }: { item: SubagentItem; onOpen?: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const { type, description } = subagentInfo(item.call);
  const state = subagentState(item);
  const report = subagentReport(item.call);
  const steps = item.steps;
  const recovered = !state.failed && state.failedSteps > 0 ? t(`chat.subagent.recovered.${state.failedSteps === 1 ? "one" : "other"}`, { count: state.failedSteps }) : "";
  const dot = state.running ? "is-live" : state.failed ? "is-failed" : "is-done";
  const liveTitle = state.current ? (state.current.title ?? state.current.kind ?? state.current.toolCallId) : t("chat.subagent.starting");
  const lineText = state.running ? liveTitle : [summaryText(steps, t, false), recovered].filter(Boolean).join(" · ");
  return (
    <div className="chat-rail chat-sub">
      <div className="chat-sub-head">
      <span className={`chat-dot ${dot}`} aria-hidden="true" />
      <button type="button" className="chat-sub-chevron" aria-expanded={open} aria-label={t("chat.subagent.inline")} title={t("chat.subagent.inline")} onClick={() => setOpen((v) => !v)}>
        {CHEVRON}
      </button>
      <button type="button" className="chat-group-toggle chat-sub-toggle" title={onOpen ? t("chat.subagent.open") : undefined} onClick={() => (onOpen ? onOpen(item.id) : setOpen((v) => !v))}>
        {BOT_ICON}
        {type && <span className="chat-sub-tag">{type}</span>}
        <span className="chat-sub-desc" title={description}>
          {description}
        </span>
        <span className="chat-group-count" title={t("chat.subagent.steps", { count: steps.length })}>
          {steps.length}
        </span>
        <span className="chat-sub-end">
          {state.running ? (
            <span className="chat-spinner" aria-hidden="true" />
          ) : (
            <>
              {state.seconds !== null && <span>{t("chat.subagent.seconds", { count: state.seconds })}</span>}
              <span className={state.failed ? "chat-sub-mark is-failed" : "chat-sub-mark"} title={state.failed ? t("chat.subagent.failed") : t("chat.subagent.done")}>
                {state.failed ? "✕" : "✓"}
              </span>
            </>
          )}
        </span>
        {onOpen && (
          <svg className="chat-sub-open" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        )}
      </button>
      </div>
      {!open && (
        <div className={`chat-sub-line${state.running ? " is-live" : ""}`}>
          <span key={state.running ? liveTitle : "summary"} className="chat-sub-line-text">
            {lineText}
          </span>
        </div>
      )}
      {open && (
        <div className="chat-sub-nest">
          {steps.map((step, i) => (
            <ToolStep key={step.id} step={step} live={state.running} index={i + 1} />
          ))}
          {report && (
            <div>
              <button type="button" className="chat-sub-report-toggle" aria-expanded={reportOpen} onClick={() => setReportOpen((v) => !v)}>
                {CHEVRON}
                {t("chat.subagent.report")}
              </button>
              {reportOpen && (
                <div className="chat-sub-report-body">
                  <ChatMarkdown text={report} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
  // The timeline rebuilds the item on every render; its call and steps keep their identity until they change.
}, (a, b) => a.onOpen === b.onOpen && a.item.call === b.item.call && a.item.steps.length === b.item.steps.length && a.item.steps.every((s, i) => s === b.item.steps[i]));

/** The words for why a turn stopped early. */
const STOP_TEXT: Record<StopKind, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  maxTokens: "chat.stop.maxTokens",
  maxTurnRequests: "chat.stop.maxTurnRequests",
  refusal: "chat.stop.refusal",
  other: "chat.stop.other",
};

/** A permission request waiting for an answer, anchored on the rail above the composer. */
export function PermissionCard({ item, onAnswer }: { item: Extract<ChatItem, { type: "permission" }>; onAnswer: ChatItemViewProps["onAnswer"] }) {
  const { t } = useI18n();
  const title = item.toolCall.title ?? item.toolCall.kind ?? t("chat.permission.title");
  const order = (o: ChatPermissionOption) => (o.kind.startsWith("reject") ? 0 : o.kind === "allow_always" ? 1 : 2);
  const options = [...item.options].sort((a, b) => order(a) - order(b));
  return (
    <div className="chat-rail">
      <span className="chat-dot is-warn" aria-hidden="true" />
      <div className="chat-permission" role="group" aria-label={t("chat.permission.title")}>
        <div className="chat-permission-text">
          <div className="chat-permission-label">{t("chat.permission.needed")}</div>
          <div className="chat-permission-title">{title}</div>
        </div>
        <div className="chat-permission-options">
          {options.map((option) => (
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
    </div>
  );
}

export function PaperclipIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </svg>
  );
}

interface ChatItemViewProps {
  item: ChatItem;
  onAnswer: (requestId: string, optionId: string | null) => void;
}

/** One entry of the conversation outside the tool rail; redrawn only when its item changed (the model keeps unchanged items as they are). */
export const ChatItemView = memo(function ChatItemView({ item }: ChatItemViewProps) {
  const { t } = useI18n();
  switch (item.type) {
    case "user":
      return (
        <div className="chat-user">
          {item.text}
          {item.attachments && item.attachments.length > 0 && (
            <div className="chat-user-files">
              {item.attachments.map((name, i) => (
                <span key={i} className="chat-file" title={name}>
                  <PaperclipIcon size={11} />
                  <span className="chat-chip-text">{name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
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
    case "error":
      return (
        <div className="chat-error" role="alert">
          {item.message}
        </div>
      );
    case "stop":
      return (
        <div className="chat-stop" role="status">
          {t(STOP_TEXT[stopKind(item.reason)], { reason: item.reason })}
        </div>
      );
    default:
      // Tool calls and permission requests are drawn by the timeline; a kind added later is skipped.
      return null;
  }
});
