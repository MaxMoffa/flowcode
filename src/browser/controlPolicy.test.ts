import { describe, expect, it } from "vitest";
import { applyConsent, decideControl, isLocalTarget, noGrants, ownerKey, parseOwner, sameOwner, type ControlGrants, type ControlPolicyInput } from "./controlPolicy";

const base = (over: Partial<ControlPolicyInput> = {}, grants: Partial<ControlGrants> = {}): ControlPolicyInput => ({
  settings: { control: "ask", eval: "local", externalInteract: "ask" },
  grants: { ...noGrants(), ...grants },
  action: "read",
  url: "http://localhost:5173/login",
  owned: true,
  paused: false,
  ...over,
});

describe("isLocalTarget", () => {
  it("counts localhost, loopback and files", () => {
    expect(isLocalTarget("http://localhost:3000")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1/x")).toBe(true);
    expect(isLocalTarget("file:///C:/a.html")).toBe(true);
    expect(isLocalTarget("https://example.com")).toBe(false);
    expect(isLocalTarget(null)).toBe(false);
  });
});

describe("decideControl", () => {
  it("refuses everything when control is off", () => {
    const d = decideControl(base({ settings: { control: "off", eval: "always", externalInteract: "yes" } }, { access: "full" }));
    expect(d.decision).toBe("deny");
  });

  it("refuses pages the owner does not drive", () => {
    expect(decideControl(base({ owned: false }, { access: "full" })).decision).toBe("deny");
  });

  it("asks once for access in ask mode, even on localhost", () => {
    expect(decideControl(base())).toEqual({ decision: "ask", card: "access" });
    expect(decideControl(base({}, { access: "full" }))).toEqual({ decision: "allow" });
  });

  it("local mode lets local pages through and asks about the others", () => {
    const settings = { control: "local" as const, eval: "local" as const, externalInteract: "ask" as const };
    expect(decideControl(base({ settings, action: "interact" })).decision).toBe("allow");
    expect(decideControl(base({ settings, action: "read", url: "https://example.com" }))).toEqual({ decision: "ask", card: "access" });
    expect(decideControl(base({ settings, action: "interact", url: "https://example.com" }))).toEqual({ decision: "ask", card: "access" });
  });

  it("remembers a denial for the session", () => {
    expect(decideControl(base({}, { access: "denied" })).decision).toBe("deny");
  });

  it("read-only access allows reading but not acting", () => {
    expect(decideControl(base({ action: "read" }, { access: "read" })).decision).toBe("allow");
    expect(decideControl(base({ action: "interact" }, { access: "read" })).decision).toBe("deny");
    expect(decideControl(base({ action: "eval" }, { access: "read" })).decision).toBe("deny");
  });

  it("pauses interaction and eval but not reading", () => {
    const grants = { access: "full" as const };
    expect(decideControl(base({ action: "interact", paused: true }, grants)).decision).toBe("deny");
    expect(decideControl(base({ action: "eval", paused: true }, grants)).decision).toBe("deny");
    expect(decideControl(base({ action: "read", paused: true }, grants)).decision).toBe("allow");
  });

  it("applies externalInteract on non-local sites", () => {
    const url = "https://shop.example.com/cart";
    const grants = { access: "full" as const };
    const withSetting = (externalInteract: "no" | "ask" | "yes", g: Partial<ControlGrants> = grants) => decideControl(base({ action: "interact", url, settings: { control: "ask", eval: "local", externalInteract } }, g));
    expect(withSetting("no").decision).toBe("deny");
    expect(withSetting("yes").decision).toBe("allow");
    expect(withSetting("ask")).toEqual({ decision: "ask", card: "interact" });
    expect(withSetting("ask", { access: "full", interactHosts: ["shop.example.com"] }).decision).toBe("allow");
  });

  it("applies the eval setting", () => {
    const grants = { access: "full" as const };
    const ev = (e: "never" | "local" | "ask" | "always", url: string, g: Partial<ControlGrants> = grants) => decideControl(base({ action: "eval", url, settings: { control: "ask", eval: e, externalInteract: "yes" } }, g));
    expect(ev("never", "http://localhost:1").decision).toBe("deny");
    expect(ev("local", "http://localhost:1").decision).toBe("allow");
    expect(ev("local", "https://example.com").decision).toBe("deny");
    expect(ev("ask", "http://localhost:1").decision).toBe("allow");
    expect(ev("ask", "https://example.com")).toEqual({ decision: "ask", card: "eval" });
    expect(ev("ask", "https://example.com", { access: "full", evalHosts: ["example.com"] }).decision).toBe("allow");
    expect(ev("always", "https://example.com").decision).toBe("allow");
  });

  it("opening needs the access answer too, but no page", () => {
    expect(decideControl(base({ action: "open", url: "https://example.com" }))).toEqual({ decision: "ask", card: "access" });
    expect(decideControl(base({ action: "open", url: "https://example.com" }, { access: "full" })).decision).toBe("allow");
  });
});

describe("applyConsent", () => {
  it("full / read set the access level", () => {
    expect(applyConsent(noGrants(), "access", "full", "").grants.access).toBe("full");
    expect(applyConsent(noGrants(), "access", "read", "").grants.access).toBe("read");
  });

  it("denying the access card is remembered, denying another card is not", () => {
    expect(applyConsent(noGrants(), "access", "deny", "")).toMatchObject({ allowed: false, grants: { access: "denied" } });
    const full = { ...noGrants(), access: "full" as const };
    expect(applyConsent(full, "eval", "deny", "x.com")).toMatchObject({ allowed: false, grants: full });
  });

  it("'site' remembers the host for that card only", () => {
    const full = { ...noGrants(), access: "full" as const };
    expect(applyConsent(full, "eval", "site", "x.com").grants.evalHosts).toEqual(["x.com"]);
    expect(applyConsent(full, "interact", "site", "x.com").grants.interactHosts).toEqual(["x.com"]);
    expect(applyConsent(full, "eval", "once", "x.com")).toMatchObject({ allowed: true, grants: full });
  });
});

describe("owner matching", () => {
  it("parses owners and compares by kind and id", () => {
    expect(parseOwner({ kind: "chat", id: "c1" })).toEqual({ kind: "chat", id: "c1" });
    expect(parseOwner({ kind: "terminal", id: "p9" })).toEqual({ kind: "terminal", id: "p9" });
    expect(parseOwner({ kind: "window", id: "x" })).toBeNull();
    expect(parseOwner({ kind: "chat" })).toBeNull();
    expect(parseOwner(null)).toBeNull();
    expect(sameOwner({ kind: "chat", id: "1" }, { kind: "chat", id: "1" })).toBe(true);
    expect(sameOwner({ kind: "chat", id: "1" }, { kind: "terminal", id: "1" })).toBe(false);
    expect(ownerKey({ kind: "chat", id: "1" })).not.toBe(ownerKey({ kind: "terminal", id: "1" }));
  });
});
