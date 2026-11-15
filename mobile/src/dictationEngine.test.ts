import { beforeEach, describe, expect, it } from "vitest";
import { desktopDictationPref, desktopDictationUsable, remoteErrorToSpeechCode, setDesktopDictationPref } from "./dictationEngine";

describe("desktopDictationUsable", () => {
  it("needs the setting, an online link and the capability", () => {
    expect(desktopDictationUsable({ pref: true, online: true, hostHasCap: true })).toBe(true);
    expect(desktopDictationUsable({ pref: false, online: true, hostHasCap: true })).toBe(false);
    expect(desktopDictationUsable({ pref: true, online: false, hostHasCap: true })).toBe(false);
    expect(desktopDictationUsable({ pref: true, online: true, hostHasCap: false })).toBe(false);
  });
});

describe("remoteErrorToSpeechCode", () => {
  it("keeps busy and words the rest as unknown", () => {
    expect(remoteErrorToSpeechCode("busy")).toBe("busy");
    expect(remoteErrorToSpeechCode("model-missing")).toBe("unknown");
    expect(remoteErrorToSpeechCode(undefined)).toBe("unknown");
  });
});

describe("the desktop dictation setting", () => {
  beforeEach(() => setDesktopDictationPref(true));

  it("is on by default and can be switched", () => {
    expect(desktopDictationPref()).toBe(true);
    setDesktopDictationPref(false);
    expect(desktopDictationPref()).toBe(false);
  });
});
