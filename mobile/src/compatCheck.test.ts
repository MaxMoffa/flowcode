import { describe, expect, it } from "vitest";
import { LEGACY_CAPS, checkCompat, hostInfoFrom, supports } from "./compatCheck";

describe("desktop compatibility", () => {
  it("treats a ready without version fields as an old desktop with the features 0.9/0.10 had", () => {
    const host = hostInfoFrom({});
    expect(host).toEqual({ appVersion: undefined, proto: 1, caps: LEGACY_CAPS, legacy: true });
    const c = checkCompat(host);
    expect(c.level).toBe("partial");
    expect(c.missing).toEqual(["rename", "closeTab", "profileAgents", "newTabProfile", "gemini"]);
    expect(supports(host, "rename")).toBe(false);
    expect(supports(host, "profiles")).toBe(true);
    expect(supports(host, "profileLogin")).toBe(true);
    expect(supports(host, "background")).toBe(true);
  });

  it("is fine with a desktop that has every capability", () => {
    const host = hostInfoFrom({ appVersion: "0.11.0", proto: 2, caps: ["rename", "closeTab", "profiles", "profileLogin", "profileAgents", "newTabProfile", "background", "gemini", "chat", "agentViews", "future"] });
    expect(checkCompat(host)).toEqual({ level: "ok", missing: [] });
  });

  it("lists only what is missing", () => {
    const host = hostInfoFrom({ appVersion: "0.10.5", proto: 2, caps: ["rename", "profiles"] });
    expect(checkCompat(host).missing).toEqual(["closeTab", "profileLogin", "profileAgents", "newTabProfile", "background", "gemini"]);
    expect(supports(host, "profiles")).toBe(true);
  });

  it("does not complain about a desktop without chat or agent views", () => {
    const host = hostInfoFrom({ appVersion: "0.13.0", proto: 2, caps: ["rename", "closeTab", "profiles", "profileLogin", "profileAgents", "newTabProfile", "background", "gemini"] });
    expect(checkCompat(host)).toEqual({ level: "ok", missing: [] });
    expect(supports(host, "chat")).toBe(false);
  });

  it("blocks a protocol below the minimum and says nothing before connecting", () => {
    expect(checkCompat({ proto: 0, caps: [], legacy: false }).level).toBe("blocked");
    expect(checkCompat(null).level).toBe("ok");
    expect(supports(null, "rename")).toBe(true);
  });
});
