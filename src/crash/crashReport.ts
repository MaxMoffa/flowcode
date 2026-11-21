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

/** What an agent concluded about a crash (the backend's `Diagnosis`, already scrubbed). */
export type Diagnosis = {
  verdict: "machine" | "flowcode" | "unknown";
  /** 0..1. */
  confidence: number;
  title: string;
  summary: string;
  evidence: string[];
  localFix: string[];
  reproSteps: string[];
  /** An open issue with the same crash. */
  existingIssue: number | null;
  /** The agent that investigated. */
  agent: string;
  at: number;
};

/** The newest pending crash plus how many older ones are waiting behind it. `report.body` already holds the diagnosis section. */
export type PendingCrash = {
  report: CrashReport;
  otherCount: number;
  diagnosis: Diagnosis | null;
  /** The crash folder, where a diagnosis chat works. */
  dir: string;
  memoryLog: string | null;
};

/** How the verdict card and the footer present a diagnosis: an issue that already exists wins over the verdict. */
export type VerdictKind = "machine" | "bug" | "dup" | "unknown";

export function verdictKind(d: Diagnosis): VerdictKind {
  if (d.existingIssue !== null) return "dup";
  return d.verdict === "machine" ? "machine" : d.verdict === "flowcode" ? "bug" : "unknown";
}

/** Message key of the confidence word ("high", "medium", "low"). */
export function confidenceKey(confidence: number): MessageKey {
  if (confidence >= 0.75) return "crash.diag.conf.high";
  return confidence >= 0.5 ? "crash.diag.conf.medium" : "crash.diag.conf.low";
}

export function issueUrl(number: number): string {
  return `https://github.com/MaxMoffa/flowcode/issues/${number}`;
}

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

/** The first message of a diagnosis chat: the crash, where its files are, what to find out and what the agent must not do. */
export function diagnosisPrompt(pending: PendingCrash, languageName: string): string {
  const { report, dir, memoryLog } = pending;
  const files = [
    `- ${dir} (your working folder): pending-${report.id}.json is the crash report as Flowcode collected it; panic-*.json, if present, is the panic Flowcode recorded.`,
    ...(memoryLog ? [`- ${memoryLog}: Flowcode's memory log (free RAM over time before the crash).`] : []),
  ];
  return [
    "Flowcode, a desktop app for coding agents, closed unexpectedly on this computer. Find out whether the crash comes from this computer or from a bug in Flowcode.",
    "",
    `Report title: ${report.title}`,
    "",
    "The report as it would be sent (already scrubbed):",
    "",
    report.body,
    "",
    "Files:",
    ...files,
    "",
    "Goal: decide if the cause is this computer (video or other drivers, antivirus or injected DLLs, low memory, CPU features, a broken install, PATH or agent installs) or a Flowcode bug. Read the report and the logs first, then check the system.",
    "",
    "Rules:",
    "- You are read-only. Do not modify, delete or install anything, do not write to the registry, do not change settings. Network only to search GitHub issues. Ask the user before anything else.",
    "- Never put user names, folder paths, computer names, emails or tokens in the diagnosis: it can end up in a public GitHub issue.",
    "",
    `Useful checks. This computer runs: ${report.os ?? "an unknown OS"} (${report.arch}).`,
    '- Windows: `wevtutil qe Application /q:"*[System[(EventID=1000 or EventID=1001)]]" /c:20 /rd:true /f:text`, `Get-CimInstance Win32_VideoController` (driver name and date), the OS build, free RAM and disk, the version of the module named in the crash.',
    "- macOS: the newest Flowcode report in ~/Library/Logs/DiagnosticReports, `system_profiler SPDisplaysDataType`, `vm_stat`.",
    "- Linux: `journalctl -p err -b -1 --no-pager | tail -50`, `dmesg | tail -50`, the graphics driver (`lspci -k | grep -A3 VGA`).",
    "",
    "Existing issues: search with `gh issue list --repo MaxMoffa/flowcode --search \"<signature>\" --state all`, or the public GitHub search API without a token (`https://api.github.com/search/issues?q=repo:MaxMoffa/flowcode+<signature>`). The signature is in the report. If an open issue is the same crash, pass its number as `existing_issue`.",
    "",
    "When you are done, call the `attach_crash_diagnosis` tool exactly once (Flowcode shows it to the user in the crash report), then give the user a 2-3 sentence summary in " + languageName + ".",
  ].join("\n");
}
