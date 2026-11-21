import { describe, expect, it } from "vitest";
import { causeKey, composeBody, confidenceKey, diagnosisPrompt, issueUrl, technicalLine, verdictKind, type CrashReport, type Diagnosis, type PendingCrash } from "./crashReport";

/** Minimal report; only the fields the helpers read matter here. */
function report(overrides: Partial<CrashReport>): CrashReport {
  return {
    id: "id-1",
    version: "0.36.0",
    os: "Windows 11",
    arch: "x86_64",
    cpu: "Intel",
    cores: 8,
    ramGb: 32,
    avx2: true,
    avx512: false,
    startedAt: 1,
    crashedAt: 2,
    kind: "panic",
    panic: null,
    native: null,
    signature: "sig",
    title: "title",
    body: "body",
    ...overrides,
  };
}

const native = (exceptionCode: string) =>
  report({
    kind: "native",
    native: { exceptionCode, exceptionName: "name", module: "flowcode.exe", moduleVersion: "0.36.0.0", offset: "0x1" },
  });

describe("causeKey", () => {
  it("maps panics to the internal error cause", () => {
    expect(causeKey(report({ kind: "panic", panic: { message: "m", location: "a.rs:1", thread: "main" } }))).toBe("crash.cause.panic");
  });

  it("maps each known native exception code", () => {
    expect(causeKey(native("0xc000001d"))).toBe("crash.cause.illegalInstruction");
    expect(causeKey(native("0xc0000005"))).toBe("crash.cause.accessViolation");
    expect(causeKey(native("0xc0000409"))).toBe("crash.cause.failFast");
    expect(causeKey(native("0xc00000fd"))).toBe("crash.cause.stackOverflow");
    expect(causeKey(native("0xc0000374"))).toBe("crash.cause.heapCorruption");
  });

  it("falls back to unknown for other codes or a missing native block", () => {
    expect(causeKey(native("0xdeadbeef"))).toBe("crash.cause.unknown");
    expect(causeKey(report({ kind: "native", native: null }))).toBe("crash.cause.unknown");
  });
});

describe("technicalLine", () => {
  it("joins exception code and module for native crashes", () => {
    expect(technicalLine(native("0xc000001d"))).toBe("0xc000001d · flowcode.exe");
  });

  it("uses the panic location for panics", () => {
    expect(technicalLine(report({ kind: "panic", panic: { message: "m", location: "src/x.rs:10:5", thread: "main" } }))).toBe(
      "src/x.rs:10:5",
    );
  });
});

describe("composeBody", () => {
  it("prepends the note under its own heading", () => {
    expect(composeBody("  dictating  \n", "BODY")).toBe("### What I was doing\ndictating\n\nBODY");
  });

  it("returns the body unchanged when the note is blank", () => {
    expect(composeBody("   ", "BODY")).toBe("BODY");
    expect(composeBody("", "BODY")).toBe("BODY");
  });
});

const diagnosis = (over: Partial<Diagnosis>): Diagnosis => ({
  verdict: "machine",
  confidence: 0.8,
  title: "t",
  summary: "s",
  evidence: [],
  localFix: [],
  reproSteps: [],
  existingIssue: null,
  agent: "claude",
  at: 1,
  ...over,
});

describe("verdictKind", () => {
  it("follows the verdict, and an existing issue wins", () => {
    expect(verdictKind(diagnosis({ verdict: "machine" }))).toBe("machine");
    expect(verdictKind(diagnosis({ verdict: "flowcode" }))).toBe("bug");
    expect(verdictKind(diagnosis({ verdict: "unknown" }))).toBe("unknown");
    expect(verdictKind(diagnosis({ verdict: "flowcode", existingIssue: 214 }))).toBe("dup");
  });
});

describe("confidenceKey", () => {
  it("buckets the confidence", () => {
    expect(confidenceKey(0.9)).toBe("crash.diag.conf.high");
    expect(confidenceKey(0.75)).toBe("crash.diag.conf.high");
    expect(confidenceKey(0.6)).toBe("crash.diag.conf.medium");
    expect(confidenceKey(0.1)).toBe("crash.diag.conf.low");
  });
});

describe("issueUrl", () => {
  it("points at the project's issue", () => {
    expect(issueUrl(214)).toBe("https://github.com/MaxMoffa/flowcode/issues/214");
  });
});

describe("diagnosisPrompt", () => {
  const pending: PendingCrash = { report: report({ id: "abc-1", title: "Crash: x", body: "### What happened" }), otherCount: 0, diagnosis: null, dir: "C:/data/crash", memoryLog: "C:/data/memory.log" };

  it("carries the report, the files, the tool and the language", () => {
    const text = diagnosisPrompt(pending, "Italian");
    expect(text).toContain("Report title: Crash: x");
    expect(text).toContain("### What happened");
    expect(text).toContain("pending-abc-1.json");
    expect(text).toContain("C:/data/memory.log");
    expect(text).toContain("attach_crash_diagnosis");
    expect(text).toContain("in Italian.");
    expect(text).toContain("read-only");
  });

  it("leaves out a memory log that does not exist", () => {
    expect(diagnosisPrompt({ ...pending, memoryLog: null }, "English")).not.toContain("memory log");
  });
});
