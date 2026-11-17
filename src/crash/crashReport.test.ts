import { describe, expect, it } from "vitest";
import { causeKey, composeBody, technicalLine, type CrashReport } from "./crashReport";

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
