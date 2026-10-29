import { describe, expect, it } from "vitest";
import {
  COMMON_DICTATION_LANGUAGES,
  INITIAL_MODELS,
  WHISPER_LANGUAGES,
  dictationLanguageParam,
  languageName,
  parseDictationLanguages,
  sanitizeLanguages,
  applyDone,
  applyModels,
  applyProgress,
  defaultModelId,
  downloadPercent,
  ellipsizeMiddle,
  formatMb,
  hasInstalledModel,
  modelForSession,
  type DictationModel,
} from "./dictationModels";

const base: DictationModel = { id: "base", sizeBytes: 148_000_000, installed: false, recommended: false };
const small: DictationModel = { id: "small-q5", sizeBytes: 190_400_000, installed: true, recommended: true };

describe("formatMb", () => {
  it("uses decimal megabytes, rounded", () => {
    expect(formatMb(148_000_000)).toBe(148);
    expect(formatMb(487_601_768)).toBe(488);
    expect(formatMb(-5)).toBe(0);
  });
});

describe("downloadPercent", () => {
  it("floors and clamps", () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(199, 200)).toBe(99);
    expect(downloadPercent(300, 200)).toBe(100);
  });

  it("is 0 while the total is unknown", () => {
    expect(downloadPercent(10, 0)).toBe(0);
  });
});

describe("models", () => {
  it("preselects the recommended model, else the first", () => {
    expect(defaultModelId([base, small])).toBe("small-q5");
    expect(defaultModelId([base])).toBe("base");
    expect(defaultModelId([])).toBeNull();
  });

  it("tells whether any is installed", () => {
    expect(hasInstalledModel([base])).toBe(false);
    expect(hasInstalledModel([base, small])).toBe(true);
  });

  it("sends the chosen model only when installed", () => {
    expect(modelForSession([base, small], "small-q5")).toBe("small-q5");
    expect(modelForSession([base, small], "base")).toBeNull();
    expect(modelForSession([base, small], null)).toBeNull();
  });
});

describe("store reducers", () => {
  it("applyModels loads the list and the running download", () => {
    const dl = { id: "base", received: 1, total: 2 };
    const next = applyModels(INITIAL_MODELS, { models: [base], downloading: dl });
    expect(next).toMatchObject({ models: [base], downloading: dl, loaded: true });
    expect(applyModels(next, { models: [base], downloading: null }).downloading).toBeNull();
  });

  it("applyProgress replaces the download and clears a stale error", () => {
    const next = applyProgress({ ...INITIAL_MODELS, error: "boom" }, { id: "base", received: 5, total: 10 });
    expect(next.downloading).toEqual({ id: "base", received: 5, total: 10 });
    expect(next.error).toBeNull();
  });
});

describe("applyDone", () => {
  const running = { ...INITIAL_MODELS, downloading: { id: "base", received: 1, total: 2 } };

  it("clears the download and announces an install once", () => {
    const next = applyDone({ ...running, error: "x", failedId: "base" }, { id: "base", done: "installed" });
    expect(next).toMatchObject({ downloading: null, error: null, failedId: null, readyTick: 1 });
  });

  it("keeps a failure's message and model for the retry", () => {
    const next = applyDone(running, { id: "base", done: "error", message: "disk full" });
    expect(next).toMatchObject({ downloading: null, error: "disk full", failedId: "base", readyTick: 0 });
  });

  it("just goes back on a cancellation", () => {
    expect(applyDone(running, { id: "base", done: "cancelled" })).toMatchObject({ downloading: null, error: null, readyTick: 0 });
  });
});

describe("ellipsizeMiddle", () => {
  it("leaves short paths alone and cuts long ones in the middle", () => {
    expect(ellipsizeMiddle("C:\a\b", 20)).toBe("C:\a\b");
    const cut = ellipsizeMiddle("C:\Users\massi\AppData\Local\Flowcode\models", 20);
    expect(cut).toHaveLength(20);
    expect(cut).toContain("…");
    expect(cut.startsWith("C:\Users")).toBe(true);
    expect(cut.endsWith("models")).toBe(true);
  });
});

describe("dictation languages", () => {
  it("parses the stored value, keeping known codes once", () => {
    expect(parseDictationLanguages("auto")).toEqual([]);
    expect(parseDictationLanguages(null)).toEqual([]);
    expect(parseDictationLanguages("it")).toEqual(["it"]);
    expect(parseDictationLanguages("it,en,xx,it, de")).toEqual(["it", "en", "de"]);
    expect(parseDictationLanguages("haw,yue")).toEqual(["haw", "yue"]);
  });

  it("sanitizes a list", () => {
    expect(sanitizeLanguages(["en", "en", "nope", "fr"])).toEqual(["en", "fr"]);
    expect(sanitizeLanguages([])).toEqual([]);
  });

  it("sends auto when empty, else the joined codes", () => {
    expect(dictationLanguageParam([])).toBe("auto");
    expect(dictationLanguageParam(["it", "en"])).toBe("it,en");
  });

  it("knows the common languages", () => {
    for (const code of COMMON_DICTATION_LANGUAGES) expect(WHISPER_LANGUAGES).toContain(code);
  });

  it("names a language, falling back to the code", () => {
    expect(languageName("it")).toBe("Italiano");
    expect(languageName("!!bad code")).toBe("!!bad code");
    expect(languageName("it")).toBe(languageName("it"));
  });
});
