import type { MessageKey } from "../i18n";
import type { DelegateStatus } from "../chat/chatModel";

/** The look of a delegate's status chip / dot / bar: the panel's chip classes (`agents-sidebar-chip--*`). */
export function delegateTone(status: string): "running" | "waiting" | "done" | "failed" | "cancelled" {
  switch (status) {
    case "running":
      return "running";
    case "waiting_for_user":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

/** The chip class of a tone, from the existing sidebar chips. */
export const TONE_CHIP: Record<ReturnType<typeof delegateTone>, string> = {
  running: "running",
  waiting: "waiting",
  done: "idle",
  failed: "busy",
  cancelled: "saved",
};

export const TONE_LABEL: Record<ReturnType<typeof delegateTone>, MessageKey> = {
  running: "agentPanel.deleg.status.running",
  waiting: "agentPanel.deleg.status.waiting",
  done: "agentPanel.deleg.status.done",
  failed: "agentPanel.deleg.status.failed",
  cancelled: "agentPanel.deleg.status.cancelled",
};

/** The history dot a status gets (`agent-history-dot--*`). */
export function historyDot(status: string): "busy" | "waiting" | "idle" | "off" {
  const tone = delegateTone(status);
  return tone === "running" ? "busy" : tone === "waiting" ? "waiting" : tone === "done" ? "idle" : "off";
}

/** How many of the delegates still work (running or waiting for the user). */
export const activeCount = (delegates: { status: DelegateStatus | string }[]): number => delegates.filter((d) => d.status === "running" || d.status === "waiting_for_user").length;
