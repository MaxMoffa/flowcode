// The window shell's state and actions, split across the `src/app` hooks and
// handed to each of them (and to the render helpers) as one object, `S`.
// A fresh object every render: a closure made during a render reads that
// render's values, exactly like the closures of the single `Shell` function
// this was split from. The hooks with no effects (useTabs, useNewTabs,
// useTerminalHandlers, useAgentLaunch, usePluginActions) run first, in that
// order: each takes what the ones before it defined straight from `S`, and
// reaches the later ones (and what Shell sets after them, see `LateBound`)
// as `S.name`, at call time only.
//
// Each hook's parameter type only names the hooks before it (plus
// `LateBound`, written out by hand): their return types are inferred, and a
// hook typed with the whole `ShellCtx` would depend on its own return type.
import type { usePanelLayout } from "./usePanelLayout";
import type { TerminalHandle } from "../terminal/Terminal";
import type { ChatTab, TermTab } from "../tabs/types";
import type { AgentCli } from "../agents/cliInfo";
import type { AgentSession } from "../agents/agentSessions";
import type { DelegateInfo } from "../chat/chatModel";
import type { OpenChatOptions } from "./types";
import type { useShellBase } from "./useShellBase";
import type { useTabs } from "./useTabs";
import type { useNewTabs } from "./useNewTabs";
import type { useTerminalHandlers } from "./useTerminalHandlers";
import type { useAgentLaunch } from "./useAgentLaunch";
import type { usePluginActions } from "./usePluginActions";
import type { useTabAgents } from "./useTabAgents";
import type { useSidebarState } from "./useSidebarState";

/** What a hook calls in the ones after it, or in what Shell sets later - each defined (and so callable) only once the render got there. */
interface LateBound {
  addTab(cwdOverride?: string, shellOverride?: string, newTab?: boolean, profileId?: string | null, dialog?: boolean): string;
  openChatTab(cli: AgentCli, cwd: string, opts?: OpenChatOptions): Promise<boolean>;
  openDelegateTab(parentTabId: string, delegate: DelegateInfo, wslDistro: string | null): void;
  sessionByTab: Map<string, AgentSession>;
  togglePanel: ReturnType<typeof usePanelLayout>["togglePanel"];
  toggleAgentTab(): void;
  activeTermHandle(): TerminalHandle | undefined;
}

/** Set on `S` by Shell itself, after the hooks above ran. */
interface ShellDerived {
  panelLayout: ReturnType<typeof usePanelLayout>;
  togglePanel: ReturnType<typeof usePanelLayout>["togglePanel"];
  activeTermHandle: () => TerminalHandle | undefined;
  terminalTabs: TermTab[];
  chatTabs: ChatTab[];
  delegateTabs: ChatTab[];
}

export type TabsCtx = ReturnType<typeof useShellBase> & LateBound;
export type NewTabsCtx = TabsCtx & ReturnType<typeof useTabs>;
export type TerminalHandlersCtx = NewTabsCtx & ReturnType<typeof useNewTabs>;
export type AgentLaunchCtx = TerminalHandlersCtx & ReturnType<typeof useTerminalHandlers>;
export type PluginActionsCtx = AgentLaunchCtx & ReturnType<typeof useAgentLaunch>;
export type TabAgentsCtx = PluginActionsCtx & ReturnType<typeof usePluginActions>;
export type SidebarStateCtx = TabAgentsCtx & ReturnType<typeof useTabAgents> & ShellDerived;
export type ShellCtx = SidebarStateCtx & ReturnType<typeof useSidebarState>;
