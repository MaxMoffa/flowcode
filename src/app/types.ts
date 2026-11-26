import type { ChatDiagnosis } from "../crash/diagnosis";
import type { ComponentProps } from "react";
import type { AgentSessionView } from "../agentViews/AgentSessionView";
import type { PromptAnchor } from "../terminal/Terminal";
import type { AgentCli } from "../agents/cliInfo";

/** The tab whose agent delegated a task: what a delegate's own tab needs from it (a terminal tab has no agent or profile of its own here). */
export interface DelegateParent {
  id: string;
  cwd: string;
  shell?: string;
  profileId?: string;
  agent: AgentCli | null;
}

/** What a terminal reports to the New Tab page turning into it: where its
 * prompt will land, and (`null`: never) where it did. */
export interface Handoff {
  anchor?: PromptAnchor;
  promptShown?: PromptAnchor | null;
}

/** The callbacks of a chat pane's AgentSessionView (see `stableChatCallbacks`). */
export type ChatCallbacks = Pick<ComponentProps<typeof AgentSessionView>, "onOpenDelegate" | "onFirstPromptSent" | "onSessionId" | "onStatus" | "onAcpVersion" | "onViewChange" | "onTalked" | "onCloser" | "onSwitchToTerminal" | "onOpenFile" | "onOpenLogin">;

/** What `openChatTab` may be told besides the agent and folder. */
export interface OpenChatOptions { profileId?: string; viewId?: string; resume?: { sessionId: string; label?: string; handoffFrom?: string; lastActiveAt?: number }; replaceTabId?: string; at?: number; shell?: string; label?: string; diagnosis?: ChatDiagnosis; firstPrompt?: string; background?: boolean; onCreated?: (tabId: string) => void }
