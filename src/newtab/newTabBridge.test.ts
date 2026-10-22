import { describe, expect, it } from "vitest";
import { parseNewTabMessage } from "../../shared/newTabBridge";

describe("parseNewTabMessage", () => {
  it("parses a launch of each kind", () => {
    for (const kind of ["recent", "favorite", "shell", "agent"]) {
      expect(parseNewTabMessage({ type: "launch", kind, id: "x" })).toEqual({ ok: true, message: { type: "launch", kind, id: "x" } });
    }
  });
  it("keeps only the fields it knows, so no path or command gets through", () => {
    expect(parseNewTabMessage({ type: "launch", kind: "shell", id: "pwsh", command: "rm -rf /", path: "C:\\" })).toEqual({
      ok: true,
      message: { type: "launch", kind: "shell", id: "pwsh" },
    });
  });
  it("reports a launch with a bad shape", () => {
    expect(parseNewTabMessage({ type: "launch" })).toEqual({ ok: false, request: "launch" });
    expect(parseNewTabMessage({ type: "launch", kind: "command", id: "x" })).toEqual({ ok: false, request: "launch" });
    expect(parseNewTabMessage({ type: "launch", kind: "recent", id: "" })).toEqual({ ok: false, request: "launch" });
    expect(parseNewTabMessage({ type: "launch", kind: "recent", id: 3 })).toEqual({ ok: false, request: "launch" });
  });
  it("parses customize", () => {
    expect(parseNewTabMessage({ type: "customize", extra: 1 })).toEqual({ ok: true, message: { type: "customize" } });
  });
  it("ignores what it does not know", () => {
    expect(parseNewTabMessage({ type: "send", text: "hi" })).toBeNull();
    expect(parseNewTabMessage({})).toBeNull();
    expect(parseNewTabMessage("launch")).toBeNull();
    expect(parseNewTabMessage(null)).toBeNull();
  });
});
