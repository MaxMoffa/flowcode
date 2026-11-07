import { describe, expect, it } from "vitest";
import { askSummary, buildAskContent, parseAskQuestions } from "./askQuestions";

const opt = (label: string, description?: string) => ({ const: label, title: label, ...(description ? { description } : {}) });

it("answers permission options by id even when their labels match", () => {
  const question = { key: "question_0", text: "Allow?", multi: false, options: [
    { label: "Allow", value: "once", recommended: true },
    { label: "Allow", value: "always", recommended: false },
    { label: "Allow (2)", value: "other", recommended: false },
  ] };
  expect(buildAskContent([question], [{ picked: [1], custom: "" }])).toEqual({ question_0: "always" });
  expect(buildAskContent([question], [{ picked: [2], custom: "" }])).toEqual({ question_0: "other" });
});

describe("parseAskQuestions", () => {
  it("reads a single question, using the message as its text and stripping (Recommended)", () => {
    const schema = {
      type: "object",
      properties: {
        question_0: { type: "string", title: "Storage", oneOf: [opt("JSON (Recommended)", "simple"), opt("SQLite")] },
        question_0_custom: { type: "string", title: "Other" },
      },
    };
    const qs = parseAskQuestions(schema, "Where to store?");
    expect(qs).toEqual([
      {
        key: "question_0",
        header: "Storage",
        text: "Where to store?",
        multi: false,
        options: [
          { label: "JSON", description: "simple", recommended: true },
          { label: "SQLite", recommended: false },
        ],
      },
    ]);
  });

  it("reads several questions in order, multi-select ones too, with per-question text", () => {
    const schema = {
      properties: {
        question_1: { type: "array", title: "Platforms", description: "Which?", items: { anyOf: [opt("Win"), opt("Mac")] } },
        question_0: { type: "string", description: "Approach?", oneOf: [opt("A"), opt("B")] },
      },
    };
    const qs = parseAskQuestions(schema, "generic");
    expect(qs.map((q) => [q.key, q.text, q.multi, q.options.length])).toEqual([
      ["question_0", "Approach?", false, 2],
      ["question_1", "Which?", true, 2],
    ]);
  });

  it("copes with junk", () => {
    expect(parseAskQuestions(null, "x")).toEqual([]);
    expect(parseAskQuestions({ properties: { question_0: 3 } }, "x")).toEqual([]);
  });
});

describe("buildAskContent", () => {
  const qs = parseAskQuestions(
    { properties: { question_0: { type: "string", oneOf: [opt("A"), opt("B")] }, question_1: { type: "array", items: { anyOf: [opt("X"), opt("Y")] } } } },
    "m",
  );
  it("sends labels, lists for multi, custom text, and omits unanswered", () => {
    expect(buildAskContent(qs, [{ picked: [1], custom: "" }, { picked: [1, 0], custom: " more " }])).toEqual({
      question_0: "B",
      question_1: ["X", "Y"],
      question_1_custom: "more",
    });
    expect(buildAskContent(qs, [{ picked: [], custom: "mine" }, { picked: [], custom: "" }])).toEqual({ question_0_custom: "mine" });
  });
  it("summarizes", () => {
    expect(askSummary(qs, { question_0: "B", question_1: ["X", "Y"], question_1_custom: "z" })).toBe("B · X, Y, z");
    expect(askSummary(qs, undefined)).toBe("");
  });
});
