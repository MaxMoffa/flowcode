import type { ComponentType } from "react";
import type { AgentCli } from "../agents/cliInfo";
import type { MessageKey } from "../i18n";
import type { ChatSession } from "../chat/useChat";
import type { SubagentItem } from "../chat/chatTimeline";
import type { ViewPluginDevice } from "../../shared/agentViewBridge";

/** How a view reaches the agent: "acp" is a chat session hosted by the app,
 * "pty" is the agent's own TUI in a terminal tab. */
export type ViewTransport = "acp" | "pty";

/** The kind of screen a view is offered on. */
export type ViewDevice = ViewPluginDevice;

export interface AgentViewProps {
  session: ChatSession;
  agent: AgentCli;
  /** Another tab is in front: the view stays mounted (the agent keeps running). */
  hidden: boolean;
  cwd: string;
  /** The tab's name. */
  title: string;
  /** Shows the session with another registered view. */
  onSwitchView: (viewId: string) => void;
  /** Opens a file in an editor tab. */
  onOpenFile: (path: string) => void;
  /** The subagent whose chat the tab shows instead of the conversation; the host owns it so its header can navigate back. Views that ignore it keep showing the conversation. */
  openSubagent?: SubagentItem | null;
  onOpenSubagent?: (id: string | null) => void;
}

/** One way to look at an agent session, picked from the registry. */
export interface AgentViewDef {
  id: string;
  /** Where a built-in view's name comes from. */
  labelKey?: MessageKey;
  /** A plugin view's name, and its translations by UI language. */
  label?: string;
  labels?: Record<string, string>;
  /** One line under the name in Settings; a built-in view's comes from `descriptionKey`. */
  description?: string;
  descriptionKey?: MessageKey;
  /** "plugin" views are installed by the user and can be removed again. */
  source: "builtin" | "plugin";
  transport: ViewTransport;
  devices: readonly ViewDevice[];
  /** Absent for "pty" views, which are opened by handing the session over to
   * a terminal tab. */
  component?: ComponentType<AgentViewProps>;
}
