import { invoke } from "@tauri-apps/api/core";
import type { MessageKey } from "../i18n";

/** A crash of the previous run, as collected by the backend. */
export type CrashReport = {
  id: string;
  version: string;
  os: string | null;
  arch: string;
  cpu: string;
  cores: number;
  ramGb: number;
  avx2: boolean | null;
  avx512: boolean | null;
  startedAt: number;
  crashedAt: number | null;
  kind: "panic" | "native";
  panic: { message: string; location: string; thread: string } | null;
  native: { exceptionCode: string; exceptionName: string; module: string; moduleVersion: string; offset: string } | null;
  signature: string;
  title: string;
  body: string;
};

/** The newest pending crash plus how many older ones are waiting behind it. */
export type PendingCrash = { report: CrashReport; otherCount: number };

/** Human-readable cause for each Windows exception code the backend reports. */
const NATIVE_CAUSES: Record<string, MessageKey> = {
  "0xc000001d": "crash.cause.illegalInstruction",
  "0xc0000005": "crash.cause.accessViolation",
  "0xc0000409": "crash.cause.failFast",
  "0xc00000fd": "crash.cause.stackOverflow",
  "0xc0000374": "crash.cause.heapCorruption",
};

/** Message key of the human cause line shown in the dialog. */
export function causeKey(report: CrashReport): MessageKey {
  if (report.kind === "panic") return "crash.cause.panic";
  return NATIVE_CAUSES[report.native?.exceptionCode ?? ""] ?? "crash.cause.unknown";
}

/** Technical line shown under the cause: the exception code for native
 * crashes, the source location for panics. */
export function technicalLine(report: CrashReport): string {
  if (report.kind === "native" && report.native) {
    return `${report.native.exceptionCode} · ${report.native.module}`;
  }
  return report.panic?.location ?? "";
}

/** Issue body: the user's note (if any) goes on top under its own heading. */
export function composeBody(note: string, body: string): string {
  const trimmed = note.trim();
  return trimmed ? `### What I was doing\n${trimmed}\n\n${body}` : body;
}

export function fetchPendingCrash(): Promise<PendingCrash | null> {
  return invoke<PendingCrash | null>("crash_pending");
}

export function dismissCrash(id: string, mute: boolean): Promise<void> {
  return invoke<void>("crash_dismiss", { id, mute });
}

export function dismissAllCrashes(): Promise<void> {
  return invoke<void>("crash_dismiss_all");
}

export function crashIssueUrl(title: string, body: string): Promise<string> {
  return invoke<string>("crash_issue_url", { title, body });
}
