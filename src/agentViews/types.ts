import type { ComponentType } from "react";
import type { AgentCli } from "../agents/cliInfo";
import type { MessageKey } from "../i18n";
import type { ChatSession } from "../chat/useChat";
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
}

/** One way to look at an agent session, picked from the registry. */
export interface AgentViewDef {
  id: string;
  /** Where a built-in view's name comes from. */
  labelKey?: MessageKey;
  /** A plugin view's name, and its translations by UI language. */
  label?: string;
  labels?: Record<string, string>;
  /** "plugin" views are installed by the user and can be removed again. */
  source: "builtin" | "plugin";
  transport: ViewTransport;
  devices: readonly ViewDevice[];
  /** Absent for "pty" views, which are opened by handing the session over to
   * a terminal tab. */
  component?: ComponentType<AgentViewProps>;
}
