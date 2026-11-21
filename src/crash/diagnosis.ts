// The crash dialog's diagnosis chat lives in App's tabs, far from the dialog: they talk through window events, like
// the usage popover's sign-in button (see app/useCliLoginEvent.ts).
import { useEffect, useRef, useState } from "react";
import { AGENT_CLIS, defaultCliStatus, type AgentCli } from "../agents/cliInfo";
import { readString, writeString } from "../lib/storage";
import type { ChatStatus } from "../chat/chatTypes";

/** The dialog asks App to open the diagnosis chat; `opened(false)` when the agent could not be started. */
const DIAGNOSIS_OPEN = "flowcode:crash-diagnosis-open";
/** The dialog asks App to bring the diagnosis chat's tab to the front / to close it. */
const DIAGNOSIS_FOCUS = "flowcode:crash-diagnosis-focus";
const DIAGNOSIS_CLOSE = "flowcode:crash-diagnosis-close";
/** The chat says where it stands (`ChatStatus`, or `closed` when its tab went). */
const DIAGNOSIS_CHAT = "flowcode:crash-diagnosis-chat";
/** The chat asks for the crash report to be shown again. */
const DIAGNOSIS_SHOW = "flowcode:crash-diagnosis-show";

const LAST_AGENT_KEY = "flowcode.crashDiagnosisAgent";

/** What makes a chat tab a diagnosis chat. */
export interface ChatDiagnosis {
  reportId: string;
  /** The first message, sent once the agent is up. */
  prompt: string;
  /** When the crash happened, as shown in the chat's banner. */
  when: string;
}

export interface DiagnosisOpen extends ChatDiagnosis {
  agent: AgentCli;
  /** The crash folder. */
  cwd: string;
  label: string;
  opened: (ok: boolean) => void;
}

export interface DiagnosisChatReport {
  reportId: string;
  status: ChatStatus | "closed";
}

export function openDiagnosisChat(detail: DiagnosisOpen): void {
  window.dispatchEvent(new CustomEvent<DiagnosisOpen>(DIAGNOSIS_OPEN, { detail }));
}

export function focusDiagnosisChat(reportId: string): void {
  window.dispatchEvent(new CustomEvent<string>(DIAGNOSIS_FOCUS, { detail: reportId }));
}

export function closeDiagnosisChat(reportId: string): void {
  window.dispatchEvent(new CustomEvent<string>(DIAGNOSIS_CLOSE, { detail: reportId }));
}

export function reportDiagnosisChat(reportId: string, status: DiagnosisChatReport["status"]): void {
  window.dispatchEvent(new CustomEvent<DiagnosisChatReport>(DIAGNOSIS_CHAT, { detail: { reportId, status } }));
}

export function showCrashReport(): void {
  window.dispatchEvent(new Event(DIAGNOSIS_SHOW));
}

/** Subscribes to one of the events above for as long as the caller is mounted. */
export function useDiagnosisEvent<T>(name: "chat" | "show", handler: (detail: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const type = name === "chat" ? DIAGNOSIS_CHAT : DIAGNOSIS_SHOW;
    const on = (e: Event) => ref.current((e as CustomEvent<T>).detail);
    window.addEventListener(type, on);
    return () => window.removeEventListener(type, on);
  }, [name]);
}

/** App's side: what to do when the dialog asks for the diagnosis chat's tab. */
export function useDiagnosisTabEvents(actions: { open: (d: DiagnosisOpen) => void; focus: (reportId: string) => void; close: (reportId: string) => void }): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const open = (e: Event) => ref.current.open((e as CustomEvent<DiagnosisOpen>).detail);
    const focus = (e: Event) => ref.current.focus((e as CustomEvent<string>).detail);
    const close = (e: Event) => ref.current.close((e as CustomEvent<string>).detail);
    window.addEventListener(DIAGNOSIS_OPEN, open);
    window.addEventListener(DIAGNOSIS_FOCUS, focus);
    window.addEventListener(DIAGNOSIS_CLOSE, close);
    return () => {
      window.removeEventListener(DIAGNOSIS_OPEN, open);
      window.removeEventListener(DIAGNOSIS_FOCUS, focus);
      window.removeEventListener(DIAGNOSIS_CLOSE, close);
    };
  }, []);
}

/** An agent the menu lists: `reason` says why it can't be picked. */
export interface DiagnosisAgent {
  cli: AgentCli;
  ready: boolean;
  reason: "notInstalled" | "notSignedIn" | null;
}

/** The agent last picked, when it is one this build knows. */
export function lastDiagnosisAgent(): AgentCli | null {
  const saved = readString(LAST_AGENT_KEY);
  return AGENT_CLIS.find((cli) => cli === saved) ?? null;
}

export function rememberDiagnosisAgent(cli: AgentCli): void {
  writeString(LAST_AGENT_KEY, cli);
}

/** The agent the main button uses: the last one picked if it is ready, else the first ready one; null when none is. */
export function defaultDiagnosisAgent(agents: DiagnosisAgent[], last: AgentCli | null): AgentCli | null {
  return agents.find((a) => a.ready && a.cli === last)?.cli ?? agents.find((a) => a.ready)?.cli ?? null;
}

/** Whether each agent is installed and signed in (null while still being checked). */
export function useDiagnosisAgents(): DiagnosisAgent[] | null {
  const [agents, setAgents] = useState<DiagnosisAgent[] | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(AGENT_CLIS.map((cli) => defaultCliStatus(cli))).then((statuses) => {
      if (!live) return;
      setAgents(
        AGENT_CLIS.map((cli, i) => {
          const status = statuses[i];
          // A failed check counts as ready, as when a tab is opened: the start tells if it isn't.
          if (!status) return { cli, ready: true, reason: null };
          if (!status.installed) return { cli, ready: false, reason: "notInstalled" };
          return status.logged_in ? { cli, ready: true, reason: null } : { cli, ready: false, reason: "notSignedIn" };
        }),
      );
    });
    return () => {
      live = false;
    };
  }, []);
  return agents;
}
