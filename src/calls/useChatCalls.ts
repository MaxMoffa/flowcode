import { useEffect, useRef } from "react";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { toolCommand } from "../../shared/agentOpen";
import { buildAskContent, type AskQuestion } from "../chat/askQuestions";
import type { ChatItem } from "../chat/chatModel";
import type { ChatPermissionOption } from "../chat/chatTypes";
import { t } from "../i18n";
import { addCall, removeCallByKey, type CallOption } from "./callStore";

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
 * not the one on screen. A delegated child's own tab (`skip`) is left out: its orchestrator's chat raises those. */
export function useChatCalls(agent: AgentCli, tabId: string | undefined, items: ChatItem[], answers: Answers, skip: boolean) {
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const raised = useRef(new Set<string>());

  useEffect(() => {
    if (!tabId || skip) return;
    const pending = new Set<string>();
    for (const item of items) {
      if (item.type !== "permission" && item.type !== "ask") continue;
      if (item.resolved !== undefined) continue;
      if (item.type === "permission") {
        const key = `perm:${item.requestId}`;
        pending.add(key);
        if (raised.current.has(key)) continue;
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
        });
      } else if (item.type === "ask") {
        const key = `ask:${item.requestId}`;
        pending.add(key);
        if (raised.current.has(key)) continue;
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
        });
      }
    }
    for (const key of [...raised.current]) {
      if (pending.has(key)) continue;
      raised.current.delete(key);
      removeCallByKey(key);
    }
  }, [agent, tabId, items, skip]);

  // The chat is gone (tab closed, restarted): whatever it asked is moot.
  useEffect(
    () => () => {
      raised.current.forEach(removeCallByKey);
      raised.current.clear();
    },
    [tabId],
  );
}
