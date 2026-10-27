import { describe, expect, it } from "vitest";
import { isHello, parseViewMessage, pluginFileUrl, resolveInsideCwd } from "../../shared/agentViewBridge";

describe("bridge handshake", () => {
  it("accepts only a v1 hello", () => {
    expect(isHello({ type: "flowcode:hello", apiVersion: 1 })).toBe(true);
    expect(isHello({ type: "flowcode:hello", apiVersion: 2 })).toBe(false);
    expect(isHello({ type: "flowcode:hello" })).toBe(false);
    expect(isHello({ type: "hello", apiVersion: 1 })).toBe(false);
    expect(isHello(null)).toBe(false);
    expect(isHello("flowcode:hello")).toBe(false);
  });
});

describe("parseViewMessage", () => {
  it("parses the known requests", () => {
    expect(parseViewMessage({ type: "send", text: "hi" })).toEqual({ ok: true, message: { type: "send", text: "hi" } });
    expect(parseViewMessage({ type: "cancel", extra: 1 })).toEqual({ ok: true, message: { type: "cancel" } });
    expect(parseViewMessage({ type: "setMode", modeId: "plan" })).toEqual({ ok: true, message: { type: "setMode", modeId: "plan" } });
    expect(parseViewMessage({ type: "setModel", modelId: "opus" })).toEqual({ ok: true, message: { type: "setModel", modelId: "opus" } });
    expect(parseViewMessage({ type: "openFile", path: "a.ts" })).toEqual({ ok: true, message: { type: "openFile", path: "a.ts" } });
    expect(parseViewMessage({ type: "switchView", viewId: "chat" })).toEqual({ ok: true, message: { type: "switchView", viewId: "chat" } });
  });
  it("reports a known request with a bad shape", () => {
    expect(parseViewMessage({ type: "send" })).toEqual({ ok: false, request: "send" });
    expect(parseViewMessage({ type: "send", text: "  " })).toEqual({ ok: false, request: "send" });
    expect(parseViewMessage({ type: "send", text: 3 })).toEqual({ ok: false, request: "send" });
    expect(parseViewMessage({ type: "setMode", modeId: "" })).toEqual({ ok: false, request: "setMode" });
    expect(parseViewMessage({ type: "setModel", modelId: 3 })).toEqual({ ok: false, request: "setModel" });
    expect(parseViewMessage({ type: "openFile", path: null })).toEqual({ ok: false, request: "openFile" });
    expect(parseViewMessage({ type: "switchView" })).toEqual({ ok: false, request: "switchView" });
  });
  it("ignores what it does not know, including any permission answer", () => {
    expect(parseViewMessage({ type: "permission", requestId: "1", optionId: "allow" })).toBeNull();
    expect(parseViewMessage({ type: "answerPermission" })).toBeNull();
    expect(parseViewMessage({})).toBeNull();
    expect(parseViewMessage("send")).toBeNull();
    expect(parseViewMessage(undefined)).toBeNull();
  });
});

describe("resolveInsideCwd", () => {
  it("resolves a relative path against a POSIX cwd", () => {
    expect(resolveInsideCwd("/home/me/app", "src/a.ts")).toBe("/home/me/app/src/a.ts");
    expect(resolveInsideCwd("/home/me/app/", "./src/../a.ts")).toBe("/home/me/app/a.ts");
    expect(resolveInsideCwd("/home/me/app", "/home/me/app/b.ts")).toBe("/home/me/app/b.ts");
  });
  it("refuses a POSIX path outside the cwd", () => {
    expect(resolveInsideCwd("/home/me/app", "../other/a.ts")).toBeNull();
    expect(resolveInsideCwd("/home/me/app", "src/../../a.ts")).toBeNull();
    expect(resolveInsideCwd("/home/me/app", "/etc/passwd")).toBeNull();
    expect(resolveInsideCwd("/home/me/app", "/home/me/app-secrets/a.ts")).toBeNull();
    expect(resolveInsideCwd("/home/me/app", "/home/me/App/a.ts")).toBeNull();
    expect(resolveInsideCwd("/home/me/app", "../../../../../x")).toBeNull();
  });
  it("refuses the cwd itself", () => {
    expect(resolveInsideCwd("/home/me/app", ".")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "src\\..")).toBeNull();
  });
  it("resolves inside a Windows cwd, ignoring case and separator style", () => {
    expect(resolveInsideCwd("C:\\work\\app", "src\\a.ts")).toBe("C:\\work\\app\\src\\a.ts");
    expect(resolveInsideCwd("C:\\work\\app", "src/a.ts")).toBe("C:\\work\\app\\src\\a.ts");
    expect(resolveInsideCwd("C:\\work\\app", "c:/WORK/App/src/a.ts")).toBe("c:\\WORK\\App\\src\\a.ts");
  });
  it("refuses a Windows path outside the cwd", () => {
    expect(resolveInsideCwd("C:\\work\\app", "..\\other\\a.ts")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "..\\..\\..\\a.ts")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "D:\\work\\app\\a.ts")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "C:\\work\\app2\\a.ts")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "C:foo")).toBeNull();
    expect(resolveInsideCwd("C:\\work\\app", "\\\\server\\share\\a.ts")).toBeNull();
  });
  it("handles a UNC cwd (WSL)", () => {
    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me";
    expect(resolveInsideCwd(cwd, "a.ts")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts");
    expect(resolveInsideCwd(cwd, "..\\a.ts")).toBeNull();
    expect(resolveInsideCwd(cwd, "\\\\wsl.localhost\\Debian\\home\\me\\a.ts")).toBeNull();
  });
});

describe("pluginFileUrl", () => {
  it("keeps the slashes between segments", () => {
    expect(pluginFileUrl("http://flowcode-plugin.localhost/timeline", "index.html")).toBe("http://flowcode-plugin.localhost/timeline/index.html");
    expect(pluginFileUrl("http://flowcode-plugin.localhost/timeline", "abc123/ui/index.html")).toBe(
      "http://flowcode-plugin.localhost/timeline/abc123/ui/index.html",
    );
  });
  it("drops trailing slashes of the root", () => {
    expect(pluginFileUrl("flowcode-plugin://localhost/timeline//", "index.html")).toBe("flowcode-plugin://localhost/timeline/index.html");
  });
  it("encodes each segment", () => {
    expect(pluginFileUrl("http://x/p", "a b/c#d?.html")).toBe("http://x/p/a%20b/c%23d%3F.html");
  });
});
