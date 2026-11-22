// The browser panel sits far from App's tabs: it asks App for a diagnosis chat, a terminal or a tab to show through
// window events, like the crash dialog does (see src/crash/diagnosis.ts).
import { useEffect, useRef } from "react";
import type { AgentCli } from "../agents/cliInfo";

const OPEN_CHAT = "flowcode:browser-diagnosis-open";
const FOCUS_TAB = "flowcode:browser-diagnosis-focus";
const OPEN_TERMINAL = "flowcode:browser-terminal-open";

export interface BrowserDiagnosisOpen {
  agent: AgentCli;
  /** The first message, sent once the agent is up. */
  prompt: string;
  label: string;
  /** The tab whose folder the chat opens in (the terminal that printed the server, or the one the page was opened for). */
  hintTabId?: string;
  /** The chat's tab was created (not called when the agent can't start). */
  onOpened: (tabId: string) => void;
}

export interface BrowserTerminalOpen {
  hintTabId?: string;
}

export function openBrowserDiagnosisChat(detail: BrowserDiagnosisOpen): void {
  window.dispatchEvent(new CustomEvent<BrowserDiagnosisOpen>(OPEN_CHAT, { detail }));
}

export function focusBrowserDiagnosisTab(tabId: string): void {
  window.dispatchEvent(new CustomEvent<string>(FOCUS_TAB, { detail: tabId }));
}

export function openBrowserTerminal(detail: BrowserTerminalOpen): void {
  window.dispatchEvent(new CustomEvent<BrowserTerminalOpen>(OPEN_TERMINAL, { detail }));
}

/** App's side. */
export function useBrowserDiagnosisEvents(actions: { openChat: (d: BrowserDiagnosisOpen) => void; focusTab: (tabId: string) => void; openTerminal: (d: BrowserTerminalOpen) => void }): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const chat = (e: Event) => ref.current.openChat((e as CustomEvent<BrowserDiagnosisOpen>).detail);
    const focus = (e: Event) => ref.current.focusTab((e as CustomEvent<string>).detail);
    const terminal = (e: Event) => ref.current.openTerminal((e as CustomEvent<BrowserTerminalOpen>).detail);
    window.addEventListener(OPEN_CHAT, chat);
    window.addEventListener(FOCUS_TAB, focus);
    window.addEventListener(OPEN_TERMINAL, terminal);
    return () => {
      window.removeEventListener(OPEN_CHAT, chat);
      window.removeEventListener(FOCUS_TAB, focus);
      window.removeEventListener(OPEN_TERMINAL, terminal);
    };
  }, []);
}
