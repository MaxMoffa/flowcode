import { useEffect, useId, useRef } from "react";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { toolCommand } from "../../shared/agentOpen";
import { buildAskContent, type AskQuestion } from "../chat/askQuestions";
import type { ChatItem } from "../chat/chatModel";
import type { ChatPermissionOption } from "../chat/chatTypes";
import { t } from "../i18n";
import { addCall, removeCallByKey, useCallsEnabled, type CallOption } from "./callStore";

interface Answers {
  permission: (requestId: string, optionId: string | null) => void;
  ask: (requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
}

const toneOf = (kind: ChatPermissionOption["kind"]): CallOption["tone"] => (kind === "allow_once" ? "primary" : kind.startsWith("reject") ? "danger" : "default");

/** The answers a question can take right in the bubble: a plain choice or free text for a single question. Several
 * questions at once need the composer. */
function askAnswers(questions: AskQuestion[]): { options?: CallOption[]; reply: boolean } {
  if (questions.length !== 1) return { reply: false };
  const [q] = questions;
  const options = q.multi ? [] : q.options.map((o, i) => ({ id: String(i), label: o.label, hint: o.description, tone: o.recommended ? ("primary" as const) : undefined }));
  return { ...(options.length ? { options } : {}), reply: true };
}

/** Raises a call for each permission request or question of the chat that waits for an answer, and drops it once that is
 * settled - here, in the tab or from the phone. `tabId` is the tab the chat lives in: the bubble only shows when it is
 * not the one on screen. `pane.parked` is set when this conversation is in the background of that tab, and `pane.sessionId`
 * is its agent session. A delegated child's own tab (`skip`) is left out: its orchestrator's chat raises those. */
export function useChatCalls(agent: AgentCli, tabId: string | undefined, items: ChatItem[], answers: Answers, skip: boolean, pane: { parked: boolean; sessionId?: string }) {
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const raised = useRef(new Set<string>());
  // Each conversation of a tab has its own request ids: the pane id keeps their keys apart.
  const paneId = useId();
  const enabled = useCallsEnabled();
  const { parked, sessionId } = pane;
  const paneSig = `${parked}|${sessionId ?? ""}`;
  const lastPane = useRef(paneSig);

  useEffect(() => {
    // Bubbles off or nothing to call about: what was raised is removed, and raised again once they are back on.
    const repaint = paneSig !== lastPane.current;
    lastPane.current = paneSig;
    if (!tabId || skip || !enabled) {
      raised.current.forEach(removeCallByKey);
      raised.current.clear();
      return;
    }
    const pending = new Set<string>();
    for (const item of items) {
      if (item.type !== "permission" && item.type !== "ask") continue;
      if (item.resolved !== undefined) continue;
      if (item.type === "permission") {
        const key = `perm:${paneId}:${item.requestId}`;
        pending.add(key);
        // A pane that moved between shown and parked re-raises its calls, so they carry the new state.
        if (raised.current.has(key) && !repaint) continue;
        raised.current.add(key);
        addCall({
          key,
          tabId,
          agent,
          kind: "permission",
          title: t("calls.title.call", { agent: cliName(agent) }),
          detail: item.toolCall.title ?? t("calls.permission.reason"),
          command: toolCommand(item.toolCall as unknown as Record<string, unknown>) ?? undefined,
          options: item.options.map((o) => ({ id: o.optionId, label: o.name, tone: toneOf(o.kind) })),
          onOption: (optionId) => answersRef.current.permission(item.requestId, optionId),
          parked,
          sessionId,
        });
      } else if (item.type === "ask") {
        const key = `ask:${paneId}:${item.requestId}`;
        pending.add(key);
        if (raised.current.has(key) && !repaint) continue;
        raised.current.add(key);
        const { options, reply } = askAnswers(item.questions);
        const accept = (answer: { picked: number[]; custom: string }) =>
          answersRef.current.ask(item.requestId, "accept", buildAskContent(item.questions, [answer]));
        addCall({
          key,
          tabId,
          agent,
          kind: "question",
          title: t("calls.title.call", { agent: cliName(agent) }),
          detail: item.questions[0]?.text ?? item.message,
          options,
          onOption: options ? (id) => accept({ picked: [Number(id)], custom: "" }) : undefined,
          onReply: reply ? (text) => accept({ picked: [], custom: text }) : undefined,
          parked,
          sessionId,
        });
      }
    }
    for (const key of [...raised.current]) {
      if (pending.has(key)) continue;
      raised.current.delete(key);
      removeCallByKey(key);
    }
  }, [agent, tabId, items, skip, enabled, paneId, paneSig, parked, sessionId]);

  // The chat is gone (tab closed, restarted): whatever it asked is moot.
  useEffect(
    () => () => {
      raised.current.forEach(removeCallByKey);
      raised.current.clear();
    },
    [tabId],
  );
}
