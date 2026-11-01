import type { TerminalHandle } from "../terminal/Terminal";
import type { AppTab, TermTab } from "../tabs/types";
import { isDialogTab } from "../tabs/tabState";
import type { SavedTab, SavedWindow } from "./session";

export interface WindowSnapshotState {
  tabs: AppTab[];
  activeTabId: string;
  restoreContent: boolean;
  dirtyEditors?: boolean;
  restoredTabIds: ReadonlySet<string>;
  terminals: ReadonlyMap<string, Pick<TerminalHandle, "wasUsed" | "serialize">>;
  restoredContent: ReadonlyMap<string, string>;
  shellOf: (tab: TermTab) => string | undefined;
}

export function windowSnapshot(state: WindowSnapshotState, bounds?: SavedWindow["bounds"]): SavedWindow {
  const { terminals, restoredContent, restoreContent } = state;
  const kept = state.tabs.filter((tab) => tab.kind !== "diff" && !isDialogTab(tab) && (tab.kind !== "terminal" || state.restoredTabIds.has(tab.id) || terminals.get(tab.id)?.wasUsed()));
  return {
    bounds,
    activeIndex: Math.max(0, kept.findIndex((tab) => tab.id === state.activeTabId)),
    tabs: kept.map((tab): SavedTab => {
      if (tab.kind === "terminal") {
        const term = terminals.get(tab.id);
        return { kind: "terminal", cwd: tab.cwd, label: tab.label, customLabel: tab.customLabel, notifyMuted: tab.notifyMuted,
          shell: state.shellOf(tab), profileId: tab.profileId,
          content: !restoreContent ? undefined : term?.wasUsed() ? term.serialize() : restoredContent.get(tab.id) };
      }
      if (tab.kind === "chat") {
        const sessionId = restoreContent && tab.talked !== false ? tab.sessionId : undefined;
        return { kind: "chat", agent: tab.agent, cwd: tab.cwd, label: tab.label, profileId: tab.profileId, sessionId, viewId: tab.viewId, lastActiveAt: sessionId ? tab.lastActiveAt : undefined };
      }
      if (tab.kind === "editor") return { kind: "editor", path: tab.path, label: tab.label };
      if (tab.kind === "changelog") return { kind: "changelog" };
      if (tab.kind === "whatsNew") return { kind: "whatsNew", version: tab.version };
      return { kind: "settings" };
    }),
  };
}
