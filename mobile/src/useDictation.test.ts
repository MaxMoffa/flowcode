import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage, speechLocale } from "./i18n";
import { appendDictation, dictationError } from "./useDictation";

describe("dictationError", () => {
  beforeEach(() => {
    setLanguage("en");
  });

  it("words each code of the speech plugin", () => {
    const words = new Set(["permission", "network", "busy", "language", "unknown"].map(dictationError));
    expect(words.size).toBe(5);
  });

  it("falls back to the unknown error for a missing or new code", () => {
    expect(dictationError(null)).toBe(dictationError("unknown"));
    expect(dictationError("something-new")).toBe(dictationError("unknown"));
  });

  it("follows the app language", () => {
    const en = dictationError("permission");
    setLanguage("it");
    expect(dictationError("permission")).not.toBe(en);
  });
});

describe("speechLocale", () => {
  it("is the recognizer's locale for the app language", () => {
    setLanguage("it");
    expect(speechLocale()).toBe("it-IT");
    setLanguage("en");
    expect(speechLocale()).toBe("en-US");
  });
});

describe("appendDictation", () => {
  it("adds a space only when needed", () => {
    expect(appendDictation("", " hi ")).toBe("hi");
    expect(appendDictation("fix", "it")).toBe("fix it");
    expect(appendDictation("fix ", "it")).toBe("fix it");
    expect(appendDictation("a\n", "b")).toBe("a\nb");
  });
});
