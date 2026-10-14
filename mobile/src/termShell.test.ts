import { describe, expect, it } from "vitest";
import { cdCommand, dialectFor, shellQuote } from "./termShell";

describe("dialectFor", () => {
  it("detects Windows shells by drive letter or backslash", () => {
    expect(dialectFor("C:\\Users\\me")).toBe("powershell");
    expect(dialectFor("D:/proj")).toBe("powershell");
    expect(dialectFor("\\\\wsl.localhost\\Ubuntu")).toBe("powershell");
    expect(dialectFor("/home/me")).toBe("posix");
  });
});

describe("shellQuote posix", () => {
  it("leaves safe paths bare", () => {
    expect(shellQuote("src/main.rs", "posix")).toBe("src/main.rs");
  });
  it("quotes and escapes single quotes", () => {
    expect(shellQuote("my dir/it's", "posix")).toBe(`'my dir/it'\\''s'`);
  });
  it("quotes expansion characters", () => {
    expect(shellQuote("a$b", "posix")).toBe("'a$b'");
  });
  it("refuses control characters", () => {
    expect(shellQuote("a\nb", "posix")).toBeNull();
    expect(shellQuote("a\x7fb", "posix")).toBeNull();
  });
});

describe("shellQuote powershell", () => {
  it("leaves safe paths bare", () => {
    expect(shellQuote("src/main.rs", "powershell")).toBe("src/main.rs");
  });
  it("doubles single quotes", () => {
    expect(shellQuote("my dir/it's", "powershell")).toBe("'my dir/it''s'");
  });
  it("doubles typographic quotes too", () => {
    expect(shellQuote("a\u2018b\u2019c", "powershell")).toBe("'a\u2018\u2018b\u2019\u2019c'");
  });
  it("quotes dollar signs without escaping", () => {
    expect(shellQuote("a$b", "powershell")).toBe("'a$b'");
  });
  it("refuses newlines", () => {
    expect(shellQuote("a\nb", "powershell")).toBeNull();
  });
});

describe("cdCommand", () => {
  it("builds posix and powershell commands", () => {
    expect(cdCommand("a b", "posix")).toBe("cd 'a b'");
    expect(cdCommand("a b", "powershell")).toBe("cd -LiteralPath 'a b'");
    expect(cdCommand("src", "posix")).toBe("cd src");
  });
  it("is null for unsafe names", () => {
    expect(cdCommand("a\nb", "posix")).toBeNull();
  });
});
